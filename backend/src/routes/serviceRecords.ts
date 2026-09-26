import { Router, Request, Response } from 'express';
import { validateRequest, validateQuery, serviceRecordSchema, batchServiceRecordsSchema, serviceRecordsQuerySchema, reviewServiceRecordSchema, reviewQueueQuerySchema } from '../middleware/validator';
import { AuthRequest, requireAdmin } from '../middleware/auth';
import {
  createServiceRecord,
  batchCreateServiceRecords,
  getVolunteerServiceRecords,
  getServiceRecordById,
  deleteServiceRecord,
  getPendingReviewQueue,
  reviewServiceRecord,
} from '../services/volunteerService';
import { sendInternalError } from '../utils/httpResponses';

const router = Router();

router.post('/', validateRequest(serviceRecordSchema), async (req: Request, res: Response) => {
  try {
    const result = await createServiceRecord(req.body);
    const statusCode = result.success ? 201 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error creating service record');
  }
});

router.post('/batch', validateRequest(batchServiceRecordsSchema), async (req: Request, res: Response) => {
  try {
    const result = await batchCreateServiceRecords(req.body.records);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error batch creating service records');
  }
});

// 管理员待审核队列：可按志愿者筛选，按志愿者和提交时间翻看
router.get('/review/queue', requireAdmin, validateQuery(reviewQueueQuerySchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const volunteerId = req.query.volunteer_id as string | undefined;
    const result = await getPendingReviewQueue(page, pageSize, volunteerId);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting review queue');
  }
});

// 管理员审核：确认后一次性结算，驳回须写明原因
router.post('/:id/review', requireAdmin, validateRequest(reviewServiceRecordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await reviewServiceRecord(
      req.params.id,
      req.body.action,
      adminId,
      req.body.reason
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error reviewing service record');
  }
});

router.get('/volunteer/:volunteerId', validateQuery(serviceRecordsQuerySchema), async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const status = req.query.status as 'pending' | 'approved' | 'rejected' | undefined;
    const result = await getVolunteerServiceRecords(req.params.volunteerId, page, pageSize, status);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting volunteer service records');
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await getServiceRecordById(req.params.id);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting service record');
  }
});

router.delete('/:id', requireAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const reason = req.query.reason as string || '管理员删除';
    const result = await deleteServiceRecord(req.params.id, adminId, reason);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error deleting service record');
  }
});

export default router;
