import { describe, expect, it } from 'vitest';
import { checkWriteRequest, formatFile, MAX_CUSTOM_POSES, parsePoseFile, readWallsFile, removeFromFile, upsertIntoFile } from './customPosesFile';
import { getPose } from './poses';

const T = getPose('t')!;
const mine = (n: number) => ({ ...T, id: `my-${n}`, name: `墙${n}` });
const HOST = 'localhost:5188';
const JSON_TYPE = 'application/json';

describe('checkWriteRequest', () => {
  it('lets the page itself write', () => {
    expect(checkWriteRequest('POST', { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin', 'content-type': JSON_TYPE })).toBeNull();
    expect(checkWriteRequest('DELETE', { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-origin' })).toBeNull();
  });

  it('lets command-line tools write (they send no Origin)', () => {
    expect(checkWriteRequest('POST', { host: HOST, 'content-type': JSON_TYPE })).toBeNull();
    expect(checkWriteRequest('POST', { host: HOST, 'content-type': 'application/json; charset=utf-8' })).toBeNull();
    expect(checkWriteRequest('DELETE', { host: HOST })).toBeNull();
  });

  it('refuses writes that come from another website', () => {
    expect(checkWriteRequest('POST', { host: HOST, origin: 'https://evil.example', 'content-type': JSON_TYPE })?.status).toBe(403);
    expect(checkWriteRequest('POST', { host: HOST, 'sec-fetch-site': 'cross-site', 'content-type': JSON_TYPE })?.status).toBe(403);
    expect(checkWriteRequest('DELETE', { host: HOST, origin: 'https://evil.example' })?.status).toBe(403);
  });

  it('refuses another program on this computer that merely shares the host name', () => {
    expect(checkWriteRequest('POST', { host: HOST, origin: 'http://localhost:9999', 'content-type': JSON_TYPE })?.status).toBe(403);
    expect(checkWriteRequest('POST', { host: HOST, 'sec-fetch-site': 'same-site', 'content-type': JSON_TYPE })?.status).toBe(403);
  });

  it('refuses an Origin it cannot read', () => {
    expect(checkWriteRequest('POST', { host: HOST, origin: 'null', 'content-type': JSON_TYPE })?.status).toBe(403);
    expect(checkWriteRequest('POST', { host: HOST, origin: 'not a url', 'content-type': JSON_TYPE })?.status).toBe(403);
  });

  it('insists on JSON for POST — a plain form post from another site never gets that far', () => {
    expect(checkWriteRequest('POST', { host: HOST, 'content-type': 'text/plain' })?.status).toBe(415);
    expect(checkWriteRequest('POST', { host: HOST, 'content-type': 'application/x-www-form-urlencoded' })?.status).toBe(415);
    expect(checkWriteRequest('POST', { host: HOST })?.status).toBe(415);
  });

  it('only knows POST and DELETE', () => {
    expect(checkWriteRequest('GET', { host: HOST })?.status).toBe(405);
    expect(checkWriteRequest('PUT', { host: HOST, 'content-type': JSON_TYPE })?.status).toBe(405);
    expect(checkWriteRequest(undefined, { host: HOST })?.status).toBe(405);
  });

  it('only accepts requests that come from this computer', () => {
    // 用 vite --host 把开发服务器开到局域网上时，别的机器也连得上。它们可以看，但不能往你的项目文件里写
    const ok = { host: HOST, 'content-type': JSON_TYPE };
    for (const local of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
      expect(checkWriteRequest('POST', ok, local), local).toBeNull();
      expect(checkWriteRequest('DELETE', { host: HOST }, local), local).toBeNull();
    }
    for (const remote of ['192.168.1.20', '10.0.0.7', '::ffff:192.168.1.20', 'fe80::1', '8.8.8.8', '', '1270.0.0.1']) {
      expect(checkWriteRequest('POST', ok, remote)?.status, remote).toBe(403);
      expect(checkWriteRequest('DELETE', { host: HOST }, remote)?.status, remote).toBe(403);
    }
    // 同源也不行：页面是从别的机器上打开的
    expect(checkWriteRequest('POST', { host: '192.168.1.5:5188', origin: 'http://192.168.1.5:5188', 'sec-fetch-site': 'same-origin', 'content-type': JSON_TYPE }, '192.168.1.20')?.status).toBe(403);
  });

  it('when it is not told where a request came from, it judges by the headers alone', () => {
    expect(checkWriteRequest('POST', { host: HOST, 'content-type': JSON_TYPE })).toBeNull();
  });

  it('takes the first value when a header arrives more than once', () => {
    expect(checkWriteRequest('POST', { host: HOST, origin: ['https://evil.example', `http://${HOST}`], 'content-type': JSON_TYPE })?.status).toBe(403);
  });
});

describe('readWallsFile', () => {
  it('a missing or empty file is an empty list', () => {
    expect(readWallsFile(null)).toEqual({ ok: true, list: [] });
    expect(readWallsFile('')).toEqual({ ok: true, list: [] });
    expect(readWallsFile('  \n')).toEqual({ ok: true, list: [] });
  });

  it('reads what formatFile wrote', () => {
    expect(readWallsFile(formatFile([mine(1), mine(2)]))).toEqual({ ok: true, list: [mine(1), mine(2)] });
  });

  it('reads a file that an editor saved with a byte-order mark', () => {
    expect(readWallsFile('\ufeff' + formatFile([mine(1)]))).toEqual({ ok: true, list: [mine(1)] });
  });

  it('keeps entries it does not understand, so a rewrite does not drop them', () => {
    const halfWritten = { id: 'draft', name: '还没写完' };
    expect(readWallsFile(JSON.stringify([halfWritten, mine(1)]))).toEqual({ ok: true, list: [halfWritten, mine(1)] });
  });

  it('refuses a file it cannot read instead of treating it as empty — rewriting it would destroy the walls in it', () => {
    const trailingComma = formatFile([mine(1), mine(2)]).replace('}\n]', '},\n]');
    for (const text of [trailingComma, '{"not": "a list"}', '"walls"', '42', '[1, 2', 'null']) {
      const r = readWallsFile(text);
      expect(r.ok, text.slice(0, 30)).toBe(false);
      expect(!r.ok && r.status, text.slice(0, 30)).toBe(409);
    }
  });
});

describe('upsertIntoFile', () => {
  it('appends a valid pose', () => {
    const r = upsertIntoFile([mine(1)], mine(2));
    expect(r.ok && r.id).toBe('my-2');
    expect(r.ok && r.list).toEqual([mine(1), mine(2)]);
  });

  it('replaces the entry with the same id and keeps its place', () => {
    const renamed = { ...mine(1), name: '改过名' };
    const r = upsertIntoFile([mine(1), mine(2)], renamed);
    expect(r.ok && r.list).toEqual([renamed, mine(2)]);
  });

  it('stores a clean copy, not whatever was sent', () => {
    const r = upsertIntoFile([], { ...mine(1), extra: 'x', __proto__: { polluted: true } });
    expect(r.ok && r.list).toEqual([mine(1)]);
  });

  it('rejects anything that is not a pose', () => {
    for (const bad of [null, 'x', 42, [], {}, { ...mine(1), id: '../x' }, { ...mine(1), armL: [{ a: 1e9 }, { a: 0 }] }]) {
      const r = upsertIntoFile([mine(2)], bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('leaves entries it does not understand alone (someone may be editing the file by hand)', () => {
    const halfWritten = { id: 'draft', name: '还没写完' };
    const r = upsertIntoFile([halfWritten, mine(1)], mine(2));
    expect(r.ok && r.list).toEqual([halfWritten, mine(1), mine(2)]);
  });

  it('refuses to grow without bound', () => {
    const full = Array.from({ length: MAX_CUSTOM_POSES }, (_, i) => mine(i));
    const more = upsertIntoFile(full, mine(MAX_CUSTOM_POSES + 1));
    expect(more.ok).toBe(false);
    expect(!more.ok && more.status).toBe(409);
    // 改已有的那些不受影响
    expect(upsertIntoFile(full, { ...mine(3), name: '改名' }).ok).toBe(true);
  });
});

describe('formatFile', () => {
  it('writes one wall per line, so the file reads well and diffs well', () => {
    const text = formatFile([mine(1), mine(2)]);
    expect(JSON.parse(text)).toEqual([mine(1), mine(2)]);
    expect(text.split('\n')).toHaveLength(5); // [ · 两面墙各一行 · ] · 结尾的空行
    expect(text.endsWith(']\n')).toBe(true);
  });

  it('writes an empty list as []', () => {
    expect(formatFile([])).toBe('[]\n');
  });
});

describe('parsePoseFile', () => {
  it('reads back what formatFile wrote', () => {
    expect(parsePoseFile(formatFile([mine(1), mine(2)]))).toEqual([mine(1), mine(2)]);
    expect(parsePoseFile('[]')).toEqual([]);
  });

  it('keeps the walls it understands and drops the rest', () => {
    const text = JSON.stringify([mine(1), { id: 'draft' }, 'x', null, { ...mine(2), extra: true }]);
    expect(parsePoseFile(text)).toEqual([mine(1), mine(2)]);
  });

  it('keeps one wall per id (the later one)', () => {
    const text = JSON.stringify([mine(1), { ...mine(1), name: '后来的' }]);
    expect(parsePoseFile(text)).toEqual([{ ...mine(1), name: '后来的' }]);
  });

  it('says so when the file is not a list of walls at all', () => {
    for (const text of ['', 'hello', '{"a":1}', '42', 'null', '"[]"']) expect(parsePoseFile(text), text).toBeNull();
  });

  it('takes at most as many walls as the file may hold', () => {
    const many = Array.from({ length: MAX_CUSTOM_POSES + 50 }, (_, i) => mine(i));
    expect(parsePoseFile(JSON.stringify(many))).toHaveLength(MAX_CUSTOM_POSES);
  });
});

describe('removeFromFile', () => {
  it('removes the entry with that id and nothing else', () => {
    expect(removeFromFile([mine(1), mine(2), mine(3)], 'my-2')).toEqual([mine(1), mine(3)]);
    expect(removeFromFile([mine(1)], 'nope')).toEqual([mine(1)]);
  });

});
