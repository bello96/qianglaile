import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupFile, restoreFile } from './fileBackup.mjs';

// 每个测试在自己的临时文件夹里做：一个"项目文件"，和一个放备份的地方（一开始不存在）
let dir;
let file;
let backup;
const text = (p) => readFileSync(p, 'utf8');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mw-backup-'));
  mkdirSync(path.join(dir, 'project'));
  file = path.join(dir, 'project', 'walls.json');
  backup = path.join(dir, 'out', 'walls.before');
  writeFileSync(file, '[1, 2, 3]\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('backupFile / restoreFile', () => {
  it('puts the file back exactly as it was, and leaves no backup behind', () => {
    expect(backupFile(file, backup)).toBe(true);
    writeFileSync(file, 'changed by the check');
    expect(restoreFile(file, backup)).toEqual({ restored: true, setAside: null });
    expect(text(file)).toBe('[1, 2, 3]\n');
    expect(readdirSync(path.dirname(backup))).toEqual([]);
  });

  it('a file that did not exist before is removed again', () => {
    rmSync(file);
    backupFile(file, backup);
    writeFileSync(file, 'created by the check');
    expect(restoreFile(file, backup).restored).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(path.dirname(backup))).toEqual([]);
  });

  it('with nothing backed up, restoring does nothing at all', () => {
    expect(restoreFile(file, backup)).toEqual({ restored: false, setAside: null });
    expect(text(file)).toBe('[1, 2, 3]\n');
  });

  it('survives the process dying between backup and restore: a later restore still works', () => {
    backupFile(file, backup);
    writeFileSync(file, 'half-way through the check');
    // ……脚本在这里被掐掉了；下一次运行一开头先恢复
    expect(restoreFile(file, backup).restored).toBe(true);
    expect(text(file)).toBe('[1, 2, 3]\n');
  });

  it('never replaces a backup that has not been put back yet — that one is the real original', () => {
    backupFile(file, backup);
    writeFileSync(file, 'changed by the check');
    expect(backupFile(file, backup)).toBe(false);
    restoreFile(file, backup);
    expect(text(file)).toBe('[1, 2, 3]\n');
  });

  it('can set aside what it finds before restoring, so nothing written in between is lost', () => {
    backupFile(file, backup);
    writeFileSync(file, 'something saved after the interrupted run');
    const aside = path.join(dir, 'out', 'found-instead.json');
    expect(restoreFile(file, backup, aside)).toEqual({ restored: true, setAside: aside });
    expect(text(file)).toBe('[1, 2, 3]\n');
    expect(text(aside)).toBe('something saved after the interrupted run');
  });

  it('sets nothing aside when the file already equals the backup', () => {
    backupFile(file, backup);
    const aside = path.join(dir, 'out', 'found-instead.json');
    expect(restoreFile(file, backup, aside)).toEqual({ restored: true, setAside: null });
    expect(existsSync(aside)).toBe(false);
  });

  it('sets aside a file that appeared where there was none', () => {
    rmSync(file);
    backupFile(file, backup);
    writeFileSync(file, 'appeared later');
    const aside = path.join(dir, 'out', 'found-instead.json');
    expect(restoreFile(file, backup, aside).setAside).toBe(aside);
    expect(existsSync(file)).toBe(false);
    expect(text(aside)).toBe('appeared later');
  });

  it('keeps bytes exactly (no re-encoding)', () => {
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x5b, 0x5d, 0x0d, 0x0a, 0xff, 0x00]);
    writeFileSync(file, bytes);
    backupFile(file, backup);
    writeFileSync(file, 'x');
    restoreFile(file, backup);
    expect(readFileSync(file).equals(bytes)).toBe(true);
  });
});
