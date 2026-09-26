// eslint-disable-next-line @typescript-eslint/no-var-requires
const EmbeddedPostgres = require('embedded-postgres').default;
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

const TEST_PORT = 55432;
const DATA_DIR = path.join(__dirname, '..', '..', '.embedded-postgres');

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || String(TEST_PORT);
process.env.DB_NAME = process.env.DB_NAME || 'postgres';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'password';

interface EmbeddedPg {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
}

let pg: EmbeddedPg | null = null;

const isPortOpen = (port: number): Promise<boolean> =>
  new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

export const startTestDatabase = async (): Promise<EmbeddedPg | null> => {
  if (pg) {
    return pg;
  }

  // 上一轮测试遗留的服务器仍在运行，直接复用即可
  if (await isPortOpen(TEST_PORT)) {
    return null;
  }

  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'password',
    port: TEST_PORT,
    persistent: true,
  }) as EmbeddedPg;

  // 数据目录已初始化过则跳过 initdb
  if (!fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'))) {
    await pg.initialise();
  }
  await pg.start();

  return pg;
};
