import { startTestDatabase } from './testDb';
import pool from '../db/pool';
import { createTables } from '../db/migrate';
import { createServiceRecord, batchCreateServiceRecords, getVolunteerServiceRecords, getPendingReviewQueue, reviewServiceRecord, getServiceRecordById } from '../services/volunteerService';
import { createVolunteer, getVolunteerById, getVolunteerPointsLogs } from '../services/volunteerManager';
import { calculatePoints } from '../services/pointsCalculator';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const testResults: TestResult[] = [];

const assert = (name: string, condition: boolean, error?: string, details?: any): void => {
  testResults.push({ name, passed: condition, error: condition ? undefined : error, details });
  console.log(`${condition ? '✓ PASS' : '✗ FAIL'} ${name}`);
  if (!condition && error) {
    console.log(`  Error: ${error}`);
  }
  if (details) {
    console.log(`  Details:`, JSON.stringify(details, null, 2));
  }
};

const uniquePhone = (() => {
  let n = 100;
  return () => `139${String(++n).padStart(8, '0')}`;
})();

const cleanup = async (): Promise<void> => {
  await pool.query('TRUNCATE service_records, points_logs, credit_logs, badges, complaints, admin_audit_logs, volunteers RESTART IDENTITY CASCADE');
};

const runTests = async (): Promise<void> => {
  console.log('\n========================================');
  console.log('  服务记录两步入账（待审核 -> 审核结算）验证用例');
  console.log('========================================\n');

  await startTestDatabase();
  await createTables();
  await cleanup();

  // 场景1：单条录入进入待审核，账户数据不动
  console.log('\n--- 场景1: 单条录入仅进入待审核 ---');
  const v1 = (await createVolunteer('审核流程测试-小明', uniquePhone())).data!;

  const createRes = await createServiceRecord({
    volunteer_id: v1.id,
    service_type: 'community_service',
    duration_hours: 2,
    rating: 5,
    description: '社区服务待审核测试',
  });
  assert('录入成功且状态为 pending', createRes.success && createRes.data?.status === 'pending', '状态应为pending', createRes.data);
  assert('录入返回提示等待审核', createRes.message?.includes('等待管理员审核') === true, '应有待审核提示', createRes.message);
  assert('录入时积分变化为0', createRes.data?.pointsChange === 0, 'pointsChange应为0', createRes.data);

  const expectedPoints = calculatePoints(2, 'community_service', 5);
  assert('录入时返回预估积分', createRes.data?.estimatedPoints === expectedPoints,
    `预估积分应为${expectedPoints}，实际${createRes.data?.estimatedPoints}`);
  assert('录入时总积分仍为0', createRes.data?.newTotalPoints === 0, '总积分应保持0', createRes.data?.newTotalPoints);

  const v1AfterCreate = (await getVolunteerById(v1.id)).data!;
  assert('志愿者总积分未变', v1AfterCreate.total_points === 0, `应为0，实际${v1AfterCreate.total_points}`);
  assert('志愿者服务次数未变', v1AfterCreate.service_count === 0, `应为0，实际${v1AfterCreate.service_count}`);
  assert('志愿者等级未变', v1AfterCreate.level === 1, `应为1，实际${v1AfterCreate.level}`);
  assert('志愿者信用分未变', v1AfterCreate.credit_score === 100, `应为100，实际${v1AfterCreate.credit_score}`);

  const badgesAfterCreate = await pool.query('SELECT COUNT(*)::int AS c FROM badges WHERE volunteer_id = $1', [v1.id]);
  assert('徽章未发放', badgesAfterCreate.rows[0].c === 0, `应为0，实际${badgesAfterCreate.rows[0].c}`);
  const pointsLogsAfterCreate = await pool.query('SELECT COUNT(*)::int AS c FROM points_logs WHERE volunteer_id = $1', [v1.id]);
  assert('积分流水未写入', pointsLogsAfterCreate.rows[0].c === 0, `应为0，实际${pointsLogsAfterCreate.rows[0].c}`);

  // 场景2：批量导入同样进入待审核
  console.log('\n--- 场景2: 批量导入进入待审核 ---');
  const v2 = (await createVolunteer('审核流程测试-批量', uniquePhone())).data!;
  const batchRes = await batchCreateServiceRecords([
    { volunteer_id: v2.id, service_type: 'education', duration_hours: 1, rating: 4 },
    { volunteer_id: v2.id, service_type: 'environmental', duration_hours: 2, rating: 5 },
  ]);
  assert('批量导入2条全部成功', batchRes.data?.successCount === 2, 'successCount应为2', batchRes.data);
  assert('批量记录全部为pending', batchRes.data?.results.every((r: any) => r.status === 'pending'), '应全部pending');
  const v2AfterBatch = (await getVolunteerById(v2.id)).data!;
  assert('批量导入后总积分为0', v2AfterBatch.total_points === 0, `应为0，实际${v2AfterBatch.total_points}`);
  assert('批量导入后服务次数为0', v2AfterBatch.service_count === 0, `应为0，实际${v2AfterBatch.service_count}`);

  // 场景3：待审核队列按志愿者和提交时间翻看
  console.log('\n--- 场景3: 待审核队列 ---');
  const queueRes = await getPendingReviewQueue(1, 50);
  assert('队列查询成功', queueRes.success === true);
  const records = queueRes.data?.records ?? [];
  assert('队列包含全部3条待审核', records.length === 3, `应为3，实际${records.length}`, records.map((r: any) => r.id));
  assert('队列带出志愿者姓名', records.every((r: any) => !!r.volunteer_name), '每条应带志愿者姓名');

  const ordered = [...records].sort((a: any, b: any) =>
    a.volunteer_id === b.volunteer_id
      ? new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      : a.volunteer_id.localeCompare(b.volunteer_id)
  );
  assert('队列按志愿者+提交时间排序', JSON.stringify(records.map((r: any) => r.id)) === JSON.stringify(ordered.map((r: any) => r.id)),
    '排序应为志愿者升序、组内提交时间升序');

  const v1Queue = await getPendingReviewQueue(1, 50, v1.id);
  assert('可按志愿者筛选队列', v1Queue.data?.records.length === 1 && v1Queue.data.records[0].volunteer_id === v1.id,
    '应只返回该志愿者的1条记录', v1Queue.data?.records);

  // 场景4：审核通过，一次性算清积分、次数、等级、徽章、信用分
  console.log('\n--- 场景4: 审核通过后一次性结算 ---');
  const recordId = createRes.data!.record.id!;
  const approveRes = await reviewServiceRecord(recordId, 'approve', 'admin-1');
  assert('审核通过成功', approveRes.success === true, '审核应成功', approveRes);
  assert('通过返回积分变化', approveRes.data?.pointsChange === expectedPoints,
    `应增加${expectedPoints}，实际${approveRes.data?.pointsChange}`);
  assert('通过后总积分正确', approveRes.data?.newTotalPoints === expectedPoints, '总积分不正确', approveRes.data);

  const v1AfterApprove = (await getVolunteerById(v1.id)).data!;
  assert('通过后志愿者总积分已更新', v1AfterApprove.total_points === expectedPoints);
  assert('通过后服务次数变为1', v1AfterApprove.service_count === 1, `应为1，实际${v1AfterApprove.service_count}`);

  const recordAfter = (await getServiceRecordById(recordId)).data;
  assert('记录状态变为approved', recordAfter.status === 'approved', recordAfter.status);
  assert('记录审核人留档', recordAfter.reviewed_by === 'admin-1', recordAfter.reviewed_by);
  assert('记录审核时间留档', !!recordAfter.reviewed_at, 'reviewed_at不应为空');

  const pointsLog = await pool.query("SELECT * FROM points_logs WHERE related_id = $1 AND related_type = 'service_record'", [recordId]);
  assert('通过后积分流水写入且只写一条', pointsLog.rows.length === 1, `应1条，实际${pointsLog.rows.length}`);

  const audit = await pool.query("SELECT * FROM admin_audit_logs WHERE target_id = $1 AND action = 'approve_service_record'", [recordId]);
  assert('审核操作写入管理员审计日志', audit.rows.length === 1, `应1条，实际${audit.rows.length}`);

  // 场景5：重复审核只认第一次结果
  console.log('\n--- 场景5: 重复审核幂等 ---');
  const repeatApprove = await reviewServiceRecord(recordId, 'approve', 'admin-2');
  assert('重复通过被拒绝', repeatApprove.success === false, '应返回失败', repeatApprove);
  assert('重复审核返回已审核标记', repeatApprove.details?.already_reviewed === true, '应带already_reviewed', repeatApprove.details);

  const v1AfterRepeat = (await getVolunteerById(v1.id)).data!;
  assert('重复审核未多加积分', v1AfterRepeat.total_points === expectedPoints,
    `积分应仍为${expectedPoints}，实际${v1AfterRepeat.total_points}`);
  assert('重复审核未多加服务次数', v1AfterRepeat.service_count === 1, `次数应仍为1，实际${v1AfterRepeat.service_count}`);
  const pointsLogCount = await pool.query("SELECT COUNT(*)::int AS c FROM points_logs WHERE related_id = $1 AND related_type = 'service_record'", [recordId]);
  assert('积分流水仍只有一条', pointsLogCount.rows[0].c === 1, `应1条，实际${pointsLogCount.rows[0].c}`);
  assert('首次审核人不被覆盖', recordAfter.reviewed_by === 'admin-1');

  const repeatReject = await reviewServiceRecord(recordId, 'reject', 'admin-2', '再次尝试驳回');
  assert('通过后再驳回同样被拒绝', repeatReject.success === false);

  // 场景6：驳回必须写原因，留档，不动任何数据
  console.log('\n--- 场景6: 驳回写原因且留档 ---');
  const v3 = (await createVolunteer('审核流程测试-驳回', uniquePhone())).data!;
  const rejectCreate = await createServiceRecord({
    volunteer_id: v3.id,
    service_type: 'education',
    duration_hours: 3,
    rating: 5,
    description: '疑似内容不实',
  });
  const rejectId = rejectCreate.data!.record.id!;

  const rejectReason = '内容不实，服务时间与实际不符，退回重录';
  const rejectRes = await reviewServiceRecord(rejectId, 'reject', 'admin-1', rejectReason);
  assert('驳回成功', rejectRes.success === true, '驳回应成功', rejectRes);
  assert('驳回返回积分变化为0', rejectRes.data?.pointsChange === 0);

  const v3AfterReject = (await getVolunteerById(v3.id)).data!;
  assert('驳回后总积分仍为0', v3AfterReject.total_points === 0, `应为0，实际${v3AfterReject.total_points}`);
  assert('驳回后服务次数仍为0', v3AfterReject.service_count === 0, `应为0，实际${v3AfterReject.service_count}`);
  assert('驳回后信用分仍为100', v3AfterReject.credit_score === 100, `应为100，实际${v3AfterReject.credit_score}`);

  const rejectedRecord = (await getServiceRecordById(rejectId)).data;
  assert('驳回记录状态为rejected', rejectedRecord.status === 'rejected');
  assert('驳回原因留档', rejectedRecord.review_reason === rejectReason, rejectedRecord.review_reason);
  assert('驳回审核人留档', rejectedRecord.reviewed_by === 'admin-1');

  const rejectAudit = await pool.query("SELECT * FROM admin_audit_logs WHERE target_id = $1 AND action = 'reject_service_record'", [rejectId]);
  assert('驳回写入审计日志', rejectAudit.rows.length === 1 && rejectAudit.rows[0].reason === rejectReason);

  const rejectedRepeat = await reviewServiceRecord(rejectId, 'approve', 'admin-2');
  assert('驳回后不可再审核通过', rejectedRepeat.success === false && rejectedRepeat.details?.status === 'rejected',
    '应返回rejected状态', rejectedRepeat);

  // 场景7：志愿者积分明细区分生效与待审核
  console.log('\n--- 场景7: 积分明细区分生效/待审核 ---');
  const v4 = (await createVolunteer('审核流程测试-明细', uniquePhone())).data!;
  const approvedOne = await createServiceRecord({
    volunteer_id: v4.id, service_type: 'community_service', duration_hours: 4, rating: 5,
  });
  await reviewServiceRecord(approvedOne.data!.record.id!, 'approve', 'admin-1');
  const pendingOne = await createServiceRecord({
    volunteer_id: v4.id, service_type: 'education', duration_hours: 2, rating: 4,
  });

  const logsRes = await getVolunteerPointsLogs(v4.id, 1, 20);
  assert('积分明细包含已生效流水', logsRes.data?.logs.length === 1 && logsRes.data.logs[0].effective === true,
    '应有1条已生效流水', logsRes.data?.logs);
  assert('积分明细包含待审核记录', logsRes.data?.pending_count === 1, '应有1条待审核', logsRes.data?.pending_records);
  assert('待审核记录标记effective=false', logsRes.data?.pending_records[0].effective === false);
  assert('待审核记录带预估积分', logsRes.data?.pending_records[0].estimated_change === pendingOne.data?.estimatedPoints);
  assert('待审核预估积分总额正确', logsRes.data?.pending_points_total === pendingOne.data?.estimatedPoints,
    `应为${pendingOne.data?.estimatedPoints}，实际${logsRes.data?.pending_points_total}`);

  // 场景8：志愿者服务记录可按状态筛选
  console.log('\n--- 场景8: 服务记录按状态筛选 ---');
  const approvedList = await getVolunteerServiceRecords(v4.id, 1, 20, 'approved');
  const pendingList = await getVolunteerServiceRecords(v4.id, 1, 20, 'pending');
  assert('approved筛选只返回已通过', approvedList.data?.records.length === 1 && approvedList.data.records[0].status === 'approved');
  assert('pending筛选只返回待审核', pendingList.data?.records.length === 1 && pendingList.data.records[0].status === 'pending');

  // 场景9：队列中不再包含已处理记录
  console.log('\n--- 场景9: 队列清理 ---');
  const queueAfter = await getPendingReviewQueue(1, 50);
  const queueIds = (queueAfter.data?.records ?? []).map((r: any) => r.id);
  assert('已通过记录离开队列', !queueIds.includes(recordId));
  assert('已驳回记录离开队列', !queueIds.includes(rejectId));
  assert('队列剩v2的2条与v4待审核的1条', queueAfter.data?.records.length === 3,
    `应剩3条，实际${queueAfter.data?.records.length}`);
  assert('v4的待审核记录仍在队列', queueIds.includes(pendingOne.data!.record.id!));

  // 场景10：多条全部通过后等级与徽章只按已生效积分结算
  console.log('\n--- 场景10: 批量通过触发等级/徽章 ---');
  const v5 = (await createVolunteer('审核流程测试-等级', uniquePhone())).data!;
  const big = await createServiceRecord({
    volunteer_id: v5.id, service_type: 'disaster_relief', duration_hours: 8, rating: 5,
  });
  const bigApprove = await reviewServiceRecord(big.data!.record.id!, 'approve', 'admin-1');
  // 救灾权重2.0: 8*10*2.0*1.2 = 192 -> 超过2级阈值100
  assert('高额积分通过后等级提升', (bigApprove.data?.newLevel ?? 0) >= 2, '应升至2级以上', bigApprove.data);
  assert('升级时发放徽章', bigApprove.data?.newBadges.length >= 1, '应至少发1枚徽章', bigApprove.data?.newBadges);

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
};

runTests().catch(error => {
  console.error('测试执行出错:', error);
  process.exit(1);
});
