import dotenv from 'dotenv';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createServiceRecord, batchCreateServiceRecords } from '../services/volunteerService';
import { getReviewQueue, reviewServiceRecord, getRecordReviewHistory } from '../services/reviewService';
import { createVolunteer, getVolunteerById, getVolunteerPointsLogs } from '../services/volunteerManager';

dotenv.config();

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({
    name,
    passed: condition,
    error: condition ? undefined : error,
    details,
  });
  const status = condition ? '✓ PASS' : '✗ FAIL';
  console.log(`${status} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  服务记录两步入账 - 审核流程验证用例');
  console.log('  测试: 待审核、审核入账、驳回留档、重复审核幂等');
  console.log('========================================\n');

  try {
    console.log('初始化数据库...');
    await createTables();

    console.log('\n--- 前置条件: 创建志愿者 ---');
    const volunteerResult = await createVolunteer('审核流程测试-志愿者', '13900000011', 'review-test@example.com');
    assert('志愿者创建成功', volunteerResult.success && !!volunteerResult.data, '志愿者创建失败', volunteerResult);
    const volunteerId = volunteerResult.data?.id;

    if (!volunteerId) {
      console.log('\n⚠️  志愿者创建失败，无法继续测试');
      return;
    }

    console.log('\n========================================');
    console.log('  场景1: 提交后进入待审核，不产生任何入账');
    console.log('========================================');

    const created = await createServiceRecord({
      volunteer_id: volunteerId,
      service_type: 'elderly_care',
      duration_hours: 3,
      rating: 5,
      description: '审核流程测试-单条录入',
    });
    assert('单条录入提交成功', created.success === true, '提交失败', created);
    assert('记录状态为待审核', created.data?.status === 'pending',
      `期望pending，实际${created.data?.status}`, created.data);
    assert('记录本身标记为pending', created.data?.record?.status === 'pending',
      `期望pending，实际${created.data?.record?.status}`, created.data?.record);
    assert('返回预计积分', (created.data?.estimatedPoints ?? 0) > 0, '应返回预计积分', created.data);

    const recordId = created.data?.record?.id;

    const afterSubmit = await getVolunteerById(volunteerId);
    assert('待审核期间积分不动', afterSubmit.data?.total_points === 0,
      `期望0，实际${afterSubmit.data?.total_points}`, afterSubmit.data);
    assert('待审核期间等级不动', afterSubmit.data?.level === 1,
      `期望1，实际${afterSubmit.data?.level}`, afterSubmit.data);
    assert('待审核期间信用分不动', afterSubmit.data?.credit_score === 100,
      `期望100，实际${afterSubmit.data?.credit_score}`, afterSubmit.data);
    assert('待审核期间服务次数不动', afterSubmit.data?.service_count === 0,
      `期望0，实际${afterSubmit.data?.service_count}`, afterSubmit.data);

    console.log('\n========================================');
    console.log('  场景2: 批量导入同样进入待审核');
    console.log('========================================');

    const batchResult = await batchCreateServiceRecords([
      { volunteer_id: volunteerId, service_type: 'education', duration_hours: 2, rating: 4, description: '批量1' },
      { volunteer_id: volunteerId, service_type: 'environmental', duration_hours: 1, rating: 5, description: '批量2' },
    ]);
    assert('批量导入成功', batchResult.success === true && batchResult.data?.successCount === 2,
      '批量导入应全部成功', batchResult.data);
    const batchStatuses = (batchResult.data?.results || []).map((r: any) => r.status);
    assert('批量记录全部为待审核', batchStatuses.every((s: string) => s === 'pending'),
      `期望全部pending，实际${JSON.stringify(batchStatuses)}`, batchStatuses);

    const afterBatch = await getVolunteerById(volunteerId);
    assert('批量导入后积分仍不动', afterBatch.data?.total_points === 0,
      `期望0，实际${afterBatch.data?.total_points}`, afterBatch.data);
    assert('批量导入后服务次数仍不动', afterBatch.data?.service_count === 0,
      `期望0，实际${afterBatch.data?.service_count}`, afterBatch.data);

    console.log('\n========================================');
    console.log('  场景3: 审核队列按志愿者和提交时间翻看');
    console.log('========================================');

    const queueAll = await getReviewQueue(1, 20, { status: 'pending' });
    assert('队列查询成功', queueAll.success === true, '队列查询失败', queueAll);
    assert('队列包含待审核记录', (queueAll.data?.pagination?.total ?? 0) >= 3,
      `期望至少3条，实际${queueAll.data?.pagination?.total}`, queueAll.data?.pagination);
    assert('返回全局待审核计数', (queueAll.data?.pending_total ?? 0) >= 3,
      `期望至少3，实际${queueAll.data?.pending_total}`, queueAll.data);

    const queueByVolunteer = await getReviewQueue(1, 20, { status: 'pending', volunteerId });
    assert('按志愿者过滤队列', queueByVolunteer.data?.pagination?.total === 3,
      `期望3条，实际${queueByVolunteer.data?.pagination?.total}`, queueByVolunteer.data?.pagination);
    const queueRecords = queueByVolunteer.data?.records || [];
    const submittedAts = queueRecords.map((r: any) => new Date(r.created_at).getTime());
    const isAscending = submittedAts.every((t: number, i: number) => i === 0 || submittedAts[i - 1] <= t);
    assert('队列默认按提交时间正序', isAscending, '队列应按提交时间正序排列', submittedAts);
    assert('队列记录带志愿者姓名', queueRecords.every((r: any) => !!r.volunteer_name),
      '队列记录应包含volunteer_name', queueRecords[0]);

    console.log('\n========================================');
    console.log('  场景4: 审核通过后按现有规则一次算清');
    console.log('========================================');

    const approveResult = await reviewServiceRecord(recordId!, 'approve', 'test-admin');
    assert('审核通过成功', approveResult.success === true, '审核失败', approveResult);
    assert('返回入账积分', (approveResult.data?.pointsChange ?? 0) > 0, '应返回入账积分', approveResult.data);
    assert('返回信用分重算结果', approveResult.data?.creditScore !== undefined,
      '应返回信用分', approveResult.data);
    assert('首次审核标记正确', approveResult.data?.alreadyReviewed === false,
      '首次审核alreadyReviewed应为false', approveResult.data);

    const expectedPoints = created.data!.estimatedPoints;
    const afterApprove = await getVolunteerById(volunteerId);
    assert('审核后积分入账', afterApprove.data?.total_points === expectedPoints,
      `期望${expectedPoints}，实际${afterApprove.data?.total_points}`, afterApprove.data);
    assert('审核后服务次数入账', afterApprove.data?.service_count === 1,
      `期望1，实际${afterApprove.data?.service_count}`, afterApprove.data);
    assert('审核后信用分已重算', (afterApprove.data?.credit_score ?? 100) >= 100,
      `信用分应>=100，实际${afterApprove.data?.credit_score}`, afterApprove.data);

    console.log('\n========================================');
    console.log('  场景5: 重复审核只认第一次结果');
    console.log('========================================');

    const duplicateApprove = await reviewServiceRecord(recordId!, 'approve', 'test-admin-2');
    assert('重复审核返回成功(幂等)', duplicateApprove.success === true, '重复审核应幂等返回', duplicateApprove);
    assert('重复审核标记为已审核', duplicateApprove.data?.alreadyReviewed === true,
      '重复审核alreadyReviewed应为true', duplicateApprove.data);
    assert('重复审核返回首次审核结果', duplicateApprove.data?.review?.action === 'approve'
      && duplicateApprove.data?.review?.reviewed_by === 'test-admin',
      '应返回首次审核记录', duplicateApprove.data?.review);

    const afterDuplicate = await getVolunteerById(volunteerId);
    assert('重复审核不重复加分', afterDuplicate.data?.total_points === expectedPoints,
      `期望${expectedPoints}，实际${afterDuplicate.data?.total_points}`, afterDuplicate.data);
    assert('重复审核不重复加次数', afterDuplicate.data?.service_count === 1,
      `期望1，实际${afterDuplicate.data?.service_count}`, afterDuplicate.data);

    const reviewHistory = await getRecordReviewHistory(recordId!);
    const effectiveReviews = (reviewHistory.data || []).filter((r) => r.is_effective);
    const attemptReviews = (reviewHistory.data || []).filter((r) => !r.is_effective);
    assert('留档中仅一条生效审核', effectiveReviews.length === 1,
      `期望1条生效，实际${effectiveReviews.length}`, reviewHistory.data);
    assert('重复尝试已留档(不生效)', attemptReviews.length === 1,
      `期望1条重复尝试，实际${attemptReviews.length}`, reviewHistory.data);

    console.log('\n========================================');
    console.log('  场景6: 驳回必须写明原因并留档');
    console.log('========================================');

    const rejectTarget = await createServiceRecord({
      volunteer_id: volunteerId,
      service_type: 'other',
      duration_hours: 10,
      rating: 5,
      description: '审核流程测试-内容不实',
    });
    const rejectRecordId = rejectTarget.data?.record?.id;

    const rejectWithoutReason = await reviewServiceRecord(rejectRecordId!, 'reject', 'test-admin');
    assert('驳回缺少原因被拒绝', rejectWithoutReason.success === false,
      '无原因驳回应失败', rejectWithoutReason);
    assert('返回原因必填提示', rejectWithoutReason.error === '驳回必须填写驳回原因',
      `实际错误: ${rejectWithoutReason.error}`, rejectWithoutReason);

    const afterFailedReject = await getVolunteerById(volunteerId);
    assert('失败驳回不改变待审核状态(积分不动)', afterFailedReject.data?.total_points === expectedPoints,
      `期望${expectedPoints}，实际${afterFailedReject.data?.total_points}`, afterFailedReject.data);

    const rejectResult = await reviewServiceRecord(rejectRecordId!, 'reject', 'test-admin', '内容不实，退回重录');
    assert('带原因驳回成功', rejectResult.success === true, '驳回应成功', rejectResult);
    assert('记录状态为已驳回', rejectResult.data?.record?.status === 'rejected',
      `期望rejected，实际${rejectResult.data?.record?.status}`, rejectResult.data?.record);
    assert('驳回原因写入记录', rejectResult.data?.record?.review_note === '内容不实，退回重录',
      '记录应包含驳回原因', rejectResult.data?.record);

    const afterReject = await getVolunteerById(volunteerId);
    assert('驳回后积分不动', afterReject.data?.total_points === expectedPoints,
      `期望${expectedPoints}，实际${afterReject.data?.total_points}`, afterReject.data);
    assert('驳回后服务次数不动', afterReject.data?.service_count === 1,
      `期望1，实际${afterReject.data?.service_count}`, afterReject.data);
    assert('驳回后信用分不动', afterReject.data?.credit_score === afterApprove.data?.credit_score,
      `期望${afterApprove.data?.credit_score}，实际${afterReject.data?.credit_score}`, afterReject.data);

    const rejectHistory = await getRecordReviewHistory(rejectRecordId!);
    const effectiveReject = (rejectHistory.data || []).find((r) => r.is_effective);
    assert('驳回已留档', !!effectiveReject && effectiveReject.action === 'reject',
      '留档中应有生效的驳回记录', rejectHistory.data);
    assert('留档包含驳回原因', effectiveReject?.reason === '内容不实，退回重录',
      `实际原因: ${effectiveReject?.reason}`, effectiveReject);
    assert('留档包含审核人', effectiveReject?.reviewed_by === 'test-admin',
      `实际审核人: ${effectiveReject?.reviewed_by}`, effectiveReject);

    console.log('\n--- 驳回后再审核，只认首次驳回结果 ---');
    const approveAfterReject = await reviewServiceRecord(rejectRecordId!, 'approve', 'test-admin-2');
    assert('驳回后再审返回首次结果', approveAfterReject.data?.alreadyReviewed === true
      && approveAfterReject.data?.review?.action === 'reject',
      '应返回首次驳回结果', approveAfterReject.data);
    const afterReReview = await getVolunteerById(volunteerId);
    assert('驳回后再审不产生入账', afterReReview.data?.total_points === expectedPoints
      && afterReReview.data?.service_count === 1,
      '积分和次数应不变', afterReReview.data);

    console.log('\n========================================');
    console.log('  场景7: 积分明细区分已生效与待审核');
    console.log('========================================');

    const pointsLogs = await getVolunteerPointsLogs(volunteerId, 1, 20);
    assert('积分明细查询成功', pointsLogs.success === true, '查询失败', pointsLogs);
    const effectiveLogs = pointsLogs.data?.logs || [];
    const pendingLogs = pointsLogs.data?.pending || [];
    assert('已生效条目标记effective', effectiveLogs.length > 0
      && effectiveLogs.every((l: any) => l.entry_status === 'effective'),
      '已生效条目应标记effective', effectiveLogs);
    assert('待审核条目单独列出', pendingLogs.length > 0
      && pendingLogs.every((l: any) => l.entry_status === 'pending'),
      '待审核条目应标记pending', pendingLogs);
    assert('待审核条目包含预计积分', pendingLogs.every((l: any) => typeof l.change_amount === 'number'),
      '待审核条目应包含预计变动', pendingLogs[0]);
    const pendingIds = pendingLogs.map((l: any) => l.record_id);
    assert('已驳回记录不出现在待审核中', !pendingIds.includes(rejectRecordId),
      '驳回记录不应列为待审核', pendingIds);
    assert('已通过记录不出现在待审核中', !pendingIds.includes(recordId),
      '已通过记录不应列为待审核', pendingIds);

    console.log('\n========================================');
    console.log('  测试结果汇总');
    console.log('========================================');
    const passed = testResults.filter(r => r.passed).length;
    const failed = testResults.filter(r => !r.passed).length;
    console.log(`总计: ${testResults.length} 个用例`);
    console.log(`通过: ${passed} 个 ✓`);
    console.log(`失败: ${failed} 个 ✗`);

    if (failed > 0) {
      console.log('\n失败用例详情:');
      testResults.filter(r => !r.passed).forEach(r => {
        console.log(`  - ${r.name}`);
        if (r.error) console.log(`    原因: ${r.error}`);
      });
    }

    console.log('\n========================================\n');
    process.exit(failed > 0 ? 1 : 0);

  } catch (error) {
    console.error('测试执行出错:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runTests();
