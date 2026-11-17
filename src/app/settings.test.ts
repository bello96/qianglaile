import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, SETTINGS_KEY } from './settings';

const storageWith = (value: string | null) => ({ getItem: (key: string) => (key === SETTINGS_KEY ? value : null) });

describe('settings', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({ difficulty: 'normal', model: 'auto', sound: true, voice: true, pip: true, skeleton: false, quality: 'auto', cameraId: '' });
  });

  it('quietly drops the old "look for two people" switch that an earlier version may have saved', () => {
    // 那个开关没有了：找几个人现在由单人 / 双人模式决定。浏览器里存着的旧值不能让读设置出错，也不该被留着
    const loaded = loadSettings(storageWith('{"twoPeople":true,"sound":false}'));
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, sound: false });
    expect('twoPeople' in loaded).toBe(false);
  });

  it('loads defaults from empty storage', () => {
    expect(loadSettings(storageWith(null))).toEqual(DEFAULT_SETTINGS);
  });

  it('fills in fields that are missing from what was saved', () => {
    expect(loadSettings(storageWith('{"difficulty":"hard","sound":false}'))).toEqual({ ...DEFAULT_SETTINGS, difficulty: 'hard', sound: false });
  });

  it('survives corrupt storage', () => {
    expect(loadSettings(storageWith('{not json'))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(storageWith('"a string"'))).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(storageWith('null'))).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects values it does not understand, field by field', () => {
    const loaded = loadSettings(storageWith('{"difficulty":"weird","model":"huge","quality":7,"sound":"yes","pip":false,"cameraId":42}'));
    expect(loaded).toEqual({ ...DEFAULT_SETTINGS, pip: false });
  });

  it('drops unknown fields', () => {
    expect(loadSettings(storageWith('{"difficulty":"easy","hax":true}'))).toEqual({ ...DEFAULT_SETTINGS, difficulty: 'easy' });
  });

  it('survives storage that throws (private browsing)', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadSettings(broken)).toEqual(DEFAULT_SETTINGS);
  });

  it('saves as JSON under one key and round-trips', () => {
    const saved: Record<string, string> = {};
    const settings = { ...DEFAULT_SETTINGS, difficulty: 'easy' as const, voice: false };
    saveSettings(settings, { setItem: (k, v) => void (saved[k] = v) });
    expect(Object.keys(saved)).toEqual([SETTINGS_KEY]);
    expect(loadSettings(storageWith(saved[SETTINGS_KEY]))).toEqual(settings);
  });

  it('does not throw when saving fails', () => {
    expect(() =>
      saveSettings(DEFAULT_SETTINGS, {
        setItem: () => {
          throw new Error('quota');
        },
      }),
    ).not.toThrow();
  });
});
