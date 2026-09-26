import {
  ApiResponse,
  ReviewServiceRecordResult,
  ServiceRecord,
  ServiceRecordReview,
  Volunteer,
} from '../types';
import pool from '../db/pool';
import { calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel, checkNewBadges } from './badgeService';
import { logCreditChange, recalculateCreditScore } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export interface ReviewQueueFilters {
  status?: string;
  volunteerId?: string;
  submittedFrom?: string;
  submittedTo?: string;
  order?: 'asc' | 'desc';
}

// 审核队列：按志愿者、提交时间筛选，默认只看待审核、按提交时间正序
export const getReviewQueue = async (
  page: number = 1,
  pageSize: number = 20,
  filters: ReviewQueueFilters = {}
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    const status = filters.status || 'pending';
    const order = filters.order === 'desc' ? 'DESC' : 'ASC';

    let where = ' WHERE 1=1';
    const params: any[] = [];

    if (status !== 'all') {
      params.push(status);
      where += ` AND sr.status = $${params.length}`;
    }
    if (filters.volunteerId) {
      params.push(filters.volunteerId);
      where += ` AND sr.volunteer_id = $${params.length}`;
    }
    if (filters.submittedFrom) {
      params.push(filters.submittedFrom);
      where += ` AND sr.created_at >= $${params.length}`;
    }
    if (filters.submittedTo) {
      params.push(filters.submittedTo);
      where += ` AND sr.created_at <= $${params.length}`;
    }

    const countResult = await client.query(
      `SELECT COUNT(*) as total FROM service_records sr${where}`,
      params
    );

    const result = await client.query(
      `SELECT sr.*, v.name as volunteer_name
       FROM service_records sr
       JOIN volunteers v ON v.id = sr.volunteer_id
       ${where}
       ORDER BY sr.created_at ${order}, sr.id ${order}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    const pendingResult = await client.query(
      "SELECT COUNT(*) as total FROM service_records WHERE status = 'pending'"
    );

    return {
      success: true,
      data: {
        records: result.rows,
        pending_total: parseInt(pendingResult.rows[0].total),
        pagination: {
          page,
          page_size: pageSize,
          total: parseInt(countResult.rows[0].total),
          total_pages: Math.ceil(parseInt(countResult.rows[0].total) / pageSize),
        },
      },
    };
  } finally {
    client.release();
  }
};

// 重复审核：只认首次结果，本次尝试以 is_effective=false 留档，不产生任何入账
const buildAlreadyReviewedResponse = async (
  recordId: string,
  action: 'approve' | 'reject',
  adminId: string,
  reason?: string
): Promise<ApiResponse<ReviewServiceRecordResult>> => {
  const client = await pool.connect();

  try {
    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1',
      [recordId]
    );

    if (recordResult.rows.length === 0) {
      return { success: false, error: messages.reviews.recordNotFound };
    }

    const record = recordResult.rows[0] as ServiceRecord;

    const firstReviewResult = await client.query(
      `SELECT * FROM service_record_reviews
       WHERE record_id = $1 AND is_effective = true
       ORDER BY created_at ASC
       LIMIT 1`,
      [recordId]
    );
    const firstReview = (firstReviewResult.rows[0] as ServiceRecordReview) || null;

    await client.query(
      `INSERT INTO service_record_reviews (record_id, volunteer_id, action, reason, points_change, is_effective, reviewed_by)
       VALUES ($1, $2, $3, $4, 0, false, $5)`,
      [recordId, record.volunteer_id, action, reason || null, adminId]
    );

    return {
      success: true,
      message: messages.reviews.alreadyReviewed,
      data: {
        record,
        review: firstReview,
        alreadyReviewed: true,
      },
    };
  } finally {
    client.release();
  }
};

// 审核服务记录：通过则按现有规则一次算清（积分/等级/徽章/服务次数/信用分），驳回只留档
export const reviewServiceRecord = async (
  recordId: string,
  action: 'approve' | 'reject',
  adminId: string,
  reason?: string
): Promise<ApiResponse<ReviewServiceRecordResult>> => {
  const trimmedReason = reason?.trim();

  if (action === 'reject' && !trimmedReason) {
    return { success: false, error: messages.reviews.reasonRequired };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 原子认领：只有 pending 记录能被审核，并发/重复审核在行锁后命中 0 行
    const claimResult = await client.query(
      `UPDATE service_records
       SET status = $2, reviewed_by = $3, reviewed_at = CURRENT_TIMESTAMP, review_note = $4
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [
        recordId,
        action === 'approve' ? 'approved' : 'rejected',
        adminId,
        trimmedReason || (action === 'approve' ? '审核通过' : null),
      ]
    );

    if (claimResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return await buildAlreadyReviewedResponse(recordId, action, adminId, trimmedReason);
    }

    const record = claimResult.rows[0] as ServiceRecord;

    if (action === 'reject') {
      const reviewInsert = await client.query(
        `INSERT INTO service_record_reviews (record_id, volunteer_id, action, reason, points_change, is_effective, reviewed_by)
         VALUES ($1, $2, 'reject', $3, 0, true, $4)
         RETURNING *`,
        [recordId, record.volunteer_id, trimmedReason, adminId]
      );

      await client.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, new_value, reason)
         VALUES ($1, 'reject_service_record', 'service_record', $2, $3, $4)`,
        [adminId, recordId, { volunteer_id: record.volunteer_id, service_type: record.service_type }, trimmedReason]
      );

      await client.query('COMMIT');

      return {
        success: true,
        message: messages.reviews.rejected,
        data: {
          record,
          review: reviewInsert.rows[0],
          alreadyReviewed: false,
        },
      };
    }

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [record.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0] as Volunteer;

    const pointsChange = record.is_no_show ? -calculateNoShowPenalty() : (record.points_earned || 0);
    const oldTotalPoints = volunteer.total_points;
    const newTotalPoints = Math.max(0, oldTotalPoints + pointsChange);
    const oldLevel = volunteer.level;
    const newLevel = calculateLevel(newTotalPoints);

    await client.query(
      `UPDATE volunteers
       SET total_points = $1,
           level = $2,
           service_count = service_count + $3
       WHERE id = $4`,
      [newTotalPoints, newLevel, record.is_no_show ? 0 : 1, volunteer.id]
    );

    await client.query(
      `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        volunteer.id,
        pointsChange,
        record.is_no_show ? '爽约扣分' : `服务积分: ${record.service_type}`,
        oldTotalPoints,
        newTotalPoints,
        recordId,
        'service_record',
      ]
    );

    let newBadges: any[] = [];
    if (newLevel > oldLevel) {
      const currentBadges = await client.query(
        'SELECT * FROM badges WHERE volunteer_id = $1',
        [volunteer.id]
      );
      newBadges = await checkNewBadges(volunteer.id, newLevel, currentBadges.rows);
    }

    const reviewInsert = await client.query(
      `INSERT INTO service_record_reviews (record_id, volunteer_id, action, reason, points_change, is_effective, reviewed_by)
       VALUES ($1, $2, 'approve', $3, $4, true, $5)
       RETURNING *`,
      [recordId, record.volunteer_id, trimmedReason || '审核通过', pointsChange, adminId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'approve_service_record', 'service_record', $2, $3, $4, $5)`,
      [
        adminId,
        recordId,
        { total_points: oldTotalPoints, level: oldLevel },
        { total_points: newTotalPoints, level: newLevel, points_change: pointsChange },
        trimmedReason || '审核通过',
      ]
    );

    await client.query('COMMIT');

    const creditResult = await recalculateCreditScore(volunteer.id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        volunteer.id,
        creditResult.changeAmount,
        record.is_no_show ? '服务爽约-信用分重算' : `完成服务-信用分重算: ${record.service_type}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        recordId,
        'service_record'
      );
    }

    return {
      success: true,
      message: messages.reviews.approved,
      data: {
        record,
        review: reviewInsert.rows[0],
        alreadyReviewed: false,
        pointsChange,
        newTotalPoints,
        newLevel,
        newBadges,
        levelUp: newLevel > oldLevel,
        creditScore: creditResult ? creditResult.afterScore : volunteer.credit_score,
        creditChange: creditResult ? creditResult.changeAmount : 0,
        creditBreakdown: creditResult?.breakdown,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.reviewServiceRecordFailed, error);
    return { success: false, error: messages.reviews.reviewFailed };
  } finally {
    client.release();
  }
};

// 单条记录的审核留档（首次生效结果 + 后续重复尝试）
export const getRecordReviewHistory = async (
  recordId: string
): Promise<ApiResponse<ServiceRecordReview[]>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT * FROM service_record_reviews
       WHERE record_id = $1
       ORDER BY created_at ASC`,
      [recordId]
    );

    return { success: true, data: result.rows };
  } finally {
    client.release();
  }
};
