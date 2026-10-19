import PgBoss from 'pg-boss';
import { config } from './config.js';

export const PROCESS_QUEUE = 'process-experience';
export const boss = new PgBoss(config.DATABASE_URL);

export async function startQueue() {
  await boss.start();
  await boss.createQueue(PROCESS_QUEUE);
}
