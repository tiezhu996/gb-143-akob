import { Volunteer, ServiceRecord, ApiResponse, CreateServiceRecordResult, ReviewServiceRecordResult, ServiceRecordStatus } from '../types';
import pool from '../db/pool';
import { calculatePoints, calculateNoShowPenalty } from './pointsCalculator';
import { calculateLevel, checkNewBadges } from './badgeService';
import { logCreditChange, isCreditLimited, CREDIT_LIMIT_THRESHOLD, recalculateCreditScore } from './creditService';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export const createServiceRecord = async (record: ServiceRecord): Promise<ApiResponse<CreateServiceRecordResult>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1',
      [record.volunteer_id]
    );

    if (volunteerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.notFound };
    }

    const volunteer = volunteerResult.rows[0] as Volunteer;

    if (isCreditLimited(volunteer.credit_score)) {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.volunteers.creditLimited,
        details: {
          credit_score: volunteer.credit_score,
          credit_limit_threshold: CREDIT_LIMIT_THRESHOLD,
          message: messages.volunteers.creditLimitedDetail(volunteer.credit_score, CREDIT_LIMIT_THRESHOLD)
        }
      };
    }

    // 录入时按现有规则预估积分，仅作展示参考，审核通过前不计入任何账户数据
    const estimatedPoints = record.is_no_show ? 0 : calculatePoints(
      record.duration_hours,
      record.service_type,
      record.rating
    );
    const estimatedChange = record.is_no_show ? -calculateNoShowPenalty() : estimatedPoints;

    const insertResult = await client.query(
      `INSERT INTO service_records
       (volunteer_id, service_type, duration_hours, rating, points_earned, is_no_show, location, description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING *`,
      [
        record.volunteer_id,
        record.service_type,
        record.duration_hours,
        record.rating,
        estimatedPoints,
        record.is_no_show || false,
        record.location,
        record.description,
      ]
    );

    const newRecord = insertResult.rows[0] as ServiceRecord;

    await client.query('COMMIT');

    // 待审核期间积分、等级、徽章、信用分、服务次数均保持不变
    return {
      success: true,
      message: messages.review.submittedPending,
      data: {
        record: newRecord,
        status: 'pending',
        pointsChange: 0,
        estimatedPoints,
        estimatedChange,
        newTotalPoints: volunteer.total_points,
        newLevel: volunteer.level,
        newBadges: [],
        levelUp: false,
        creditScore: volunteer.credit_score,
        creditChange: 0,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.createServiceRecordFailed, error);
    return { success: false, error: messages.volunteers.serviceRecordCreateFailed };
  } finally {
    client.release();
  }
};

export const batchCreateServiceRecords = async (
  records: ServiceRecord[]
): Promise<ApiResponse<any>> => {
  const results: any[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const record of records) {
    const result = await createServiceRecord(record);
    if (result.success) {
      successCount++;
      results.push(result.data);
    } else {
      failCount++;
      results.push({ error: result.error, record });
    }
  }

  return {
    success: true,
    data: {
      total: records.length,
      successCount,
      failCount,
      results,
    },
  };
};

export const getVolunteerServiceRecords = async (
  volunteerId: string,
  page: number = 1,
  pageSize: number = 20,
  status?: ServiceRecordStatus
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    const params: any[] = [volunteerId];
    let whereClause = 'WHERE volunteer_id = $1';

    if (status) {
      params.push(status);
      whereClause += ` AND status = $${params.length}`;
    }

    const countResult = await client.query(
      `SELECT COUNT(*) as total FROM service_records ${whereClause}`,
      params
    );

    const recordsResult = await client.query(
      `SELECT * FROM service_records
       ${whereClause}
       ORDER BY recorded_at DESC, created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    return {
      success: true,
      data: {
        records: recordsResult.rows,
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

export const getServiceRecordById = async (
  recordId: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT * FROM service_records WHERE id = $1',
      [recordId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    return { success: true, data: result.rows[0] };
  } finally {
    client.release();
  }
};

/**
 * 管理员按志愿者和提交时间翻看待审核队列。
 * 同一志愿者的记录排在一起，组内按提交时间从早到晚。
 */
export const getPendingReviewQueue = async (
  page: number = 1,
  pageSize: number = 20,
  volunteerId?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    const offset = (page - 1) * pageSize;
    const params: any[] = [];
    let whereClause = "WHERE sr.status = 'pending'";

    if (volunteerId) {
      params.push(volunteerId);
      whereClause += ` AND sr.volunteer_id = $${params.length}`;
    }

    const countResult = await client.query(
      `SELECT COUNT(*) as total FROM service_records sr ${whereClause}`,
      params
    );

    const recordsResult = await client.query(
      `SELECT sr.*, v.name as volunteer_name
       FROM service_records sr
       JOIN volunteers v ON v.id = sr.volunteer_id
       ${whereClause}
       ORDER BY sr.volunteer_id ASC, sr.created_at ASC, sr.id ASC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    );

    return {
      success: true,
      data: {
        records: recordsResult.rows,
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

/**
 * 审核服务记录。通过则按现有规则一次性结算积分、服务次数、等级、徽章和信用分；
 * 驳回仅记录原因并存档，不动任何账户数据。
 * 同一条记录重复审核只认第一次结果，后续请求直接返回首次审核信息。
 */
export const reviewServiceRecord = async (
  recordId: string,
  action: 'approve' | 'reject',
  adminId: string,
  reason?: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 锁定记录行，并发的两次审核请求只有第一个能进入待审核分支
    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [recordId]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = recordResult.rows[0] as ServiceRecord;

    if (record.status !== 'pending') {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.review.alreadyReviewed(record.status as ServiceRecordStatus),
        details: {
          already_reviewed: true,
          status: record.status,
          reviewed_by: record.reviewed_by,
          reviewed_at: record.reviewed_at,
          review_reason: record.review_reason,
        },
      };
    }

    const reviewReason = reason?.trim() || (action === 'approve'
      ? messages.review.defaultApproveReason
      : messages.review.defaultRejectReason);

    if (action === 'reject') {
      const updatedResult = await client.query(
        `UPDATE service_records
         SET status = 'rejected',
             reviewed_by = $1,
             review_reason = $2,
             reviewed_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING *`,
        [adminId, reviewReason, recordId]
      );

      const volunteerResult = await client.query(
        'SELECT * FROM volunteers WHERE id = $1',
        [record.volunteer_id]
      );
      const volunteer = volunteerResult.rows[0] as Volunteer;

      await client.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
         VALUES ($1, 'reject_service_record', 'service_record', $2, $3, $4, $5)`,
        [
          adminId,
          recordId,
          { status: 'pending' },
          { status: 'rejected' },
          reviewReason,
        ]
      );

      await client.query('COMMIT');

      // 驳回不动积分、等级、徽章、信用分、服务次数
      return {
        success: true,
        message: messages.review.rejected,
        data: {
          record: updatedResult.rows[0],
          pointsChange: 0,
          newTotalPoints: volunteer?.total_points ?? 0,
          newLevel: volunteer?.level ?? 1,
          newBadges: [],
          levelUp: false,
          creditScore: volunteer?.credit_score ?? 100,
          creditChange: 0,
        } satisfies ReviewServiceRecordResult,
      };
    }

    // 审核通过：锁定志愿者行，串行结算，避免并发审核导致积分覆盖
    const volunteerResult = await client.query(
      'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
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
        record.is_no_show ? '审核通过-爽约扣分' : `审核通过-服务积分: ${record.service_type}`,
        oldTotalPoints,
        newTotalPoints,
        record.id,
        'service_record',
      ]
    );

    let newBadges: any[] = [];
    if (newLevel > oldLevel) {
      const currentBadges = await client.query(
        'SELECT * FROM badges WHERE volunteer_id = $1',
        [volunteer.id]
      );
      newBadges = await checkNewBadges(volunteer.id, newLevel, currentBadges.rows, client);
    }

    const approvedRecordResult = await client.query(
      `UPDATE service_records
       SET status = 'approved',
           reviewed_by = $1,
           review_reason = $2,
           reviewed_at = CURRENT_TIMESTAMP
       WHERE id = $3
       RETURNING *`,
      [adminId, reviewReason, recordId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'approve_service_record', 'service_record', $2, $3, $4, $5)`,
      [
        adminId,
        recordId,
        { status: 'pending', points_earned: record.points_earned },
        {
          status: 'approved',
          points_change: pointsChange,
          total_points: newTotalPoints,
          level: newLevel,
          new_badges: newBadges.map((b: any) => b.star_level),
        },
        reviewReason,
      ]
    );

    await client.query('COMMIT');

    // 记录已提交为 approved，重算只统计已通过记录，结果与本次结算一致
    const creditResult = await recalculateCreditScore(volunteer.id);
    if (creditResult && creditResult.changeAmount !== 0) {
      await logCreditChange(
        volunteer.id,
        creditResult.changeAmount,
        record.is_no_show ? '审核通过-服务爽约信用分重算' : `审核通过-完成服务信用分重算: ${record.service_type}`,
        creditResult.beforeScore,
        creditResult.afterScore,
        record.id,
        'service_record'
      );
    }

    return {
      success: true,
      message: messages.review.approved,
      data: {
        record: approvedRecordResult.rows[0],
        pointsChange,
        newTotalPoints,
        newLevel,
        newBadges,
        levelUp: newLevel > oldLevel,
        creditScore: creditResult ? creditResult.afterScore : volunteer.credit_score,
        creditChange: creditResult ? creditResult.changeAmount : 0,
        creditBreakdown: creditResult?.breakdown,
      } satisfies ReviewServiceRecordResult,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.reviewServiceRecordFailed, error);
    return { success: false, error: messages.review.reviewFailed };
  } finally {
    client.release();
  }
};

export const deleteServiceRecord = async (
  recordId: string,
  adminId: string,
  reason: string
): Promise<ApiResponse<any>> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const recordResult = await client.query(
      'SELECT * FROM service_records WHERE id = $1 FOR UPDATE',
      [recordId]
    );

    if (recordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.volunteers.serviceRecordNotFound };
    }

    const record = recordResult.rows[0] as ServiceRecord;
    const wasSettled = record.status === 'approved';

    if (wasSettled) {
      const volunteerResult = await client.query(
        'SELECT * FROM volunteers WHERE id = $1 FOR UPDATE',
        [record.volunteer_id]
      );

      if (volunteerResult.rows.length > 0) {
        const volunteer = volunteerResult.rows[0] as Volunteer;
        const pointsToDeduct = record.points_earned || 0;
        const newTotalPoints = Math.max(0, volunteer.total_points - pointsToDeduct);
        const newLevel = calculateLevel(newTotalPoints);

        await client.query(
          `UPDATE volunteers
           SET total_points = $1, level = $2,
               service_count = GREATEST(0, service_count - $4)
           WHERE id = $3`,
          [newTotalPoints, newLevel, volunteer.id, record.is_no_show ? 0 : 1]
        );

        await client.query(
          `INSERT INTO points_logs (volunteer_id, change_amount, reason, before_points, after_points, related_id, related_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [volunteer.id, -pointsToDeduct, `管理员删除记录: ${reason}`, volunteer.total_points, newTotalPoints, recordId, 'admin_delete']
        );
      }
    }

    await client.query('DELETE FROM service_records WHERE id = $1', [recordId]);

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [adminId, 'delete', 'service_record', recordId, { ...record, settled: wasSettled }, reason]
    );

    await client.query('COMMIT');

    // 只有已入账的记录被删才会影响信用分；待审核/已驳回的记录从未参与计算
    if (wasSettled) {
      const creditResult = await recalculateCreditScore(record.volunteer_id);
      if (creditResult && creditResult.changeAmount !== 0) {
        await logCreditChange(
          record.volunteer_id,
          creditResult.changeAmount,
          '删除服务记录-信用分重算',
          creditResult.beforeScore,
          creditResult.afterScore,
          recordId,
          'admin_delete'
        );

        return {
          success: true,
          message: messages.volunteers.serviceRecordDeleted,
          data: {
            creditScore: creditResult.afterScore,
            creditChange: creditResult.changeAmount,
            creditBreakdown: creditResult.breakdown,
          },
        };
      }
    }

    return {
      success: true,
      message: messages.volunteers.serviceRecordDeleted,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.deleteServiceRecordFailed, error);
    return { success: false, error: messages.volunteers.serviceRecordDeleteFailed };
  } finally {
    client.release();
  }
};
