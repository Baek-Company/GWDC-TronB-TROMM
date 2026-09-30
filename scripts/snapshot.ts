import { mkdir, writeFile } from 'node:fs/promises';
import { readMarkets } from '../server/data';

const live = await readMarkets(true);
await mkdir('data/snapshots', { recursive: true });
const path = `data/snapshots/justlend-${live.fetchedAt.replaceAll(':', '-')}.json`;
await writeFile(path, JSON.stringify({ ...live, mode: 'snapshot', note: '과거 조회 기록입니다. 현재 수익률로 사용하지 마세요.' }, null, 2));
console.log(path);
