// 给"会改项目文件的检查"用的备份 / 恢复。
//
// 端到端检查里有一个场景要真的改 public/custom-poses.json（里面可能有你自己存的墙）。
// 只把原来的内容记在内存里是不够的：脚本中途被掐掉（Ctrl+C、断电、超时被杀），内存里那份就没了，
// 文件停在被改过的样子。所以备份要落在磁盘上，而且"恢复"要能在下一次运行一开头补做。
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 备份有两种样子：文件原本存在 → 它的一份原样拷贝；原本不存在 → 一个空的记号文件
const copyOf = (backup) => `${backup}.bytes`;
const absentMark = (backup) => `${backup}.absent`;

/**
 * 把 file 现在的样子记到 backup（一个不带扩展名的路径，放在别的文件夹里）。
 * 已经有一份还没放回去的备份时什么也不做，返回 false：那一份才是真正的"原样"，
 * 而 file 现在的内容可能已经是被改过的了。
 */
export function backupFile(file, backup) {
  if (existsSync(copyOf(backup)) || existsSync(absentMark(backup))) return false;
  mkdirSync(path.dirname(backup), { recursive: true });
  if (existsSync(file)) copyFileSync(file, copyOf(backup));
  else writeFileSync(absentMark(backup), '');
  return true;
}

/**
 * 把备份放回去，然后删掉备份。没有备份就什么也不做。
 * asideTo：给了的话，放回去之前先看 file 现在的内容——和备份不一样，就把它另存到 asideTo，
 * 免得"上次中断之后才写进去的东西"被恢复盖掉。
 * 返回 { restored: 有没有恢复, setAside: 另存到了哪（没有另存是 null） }。
 */
export function restoreFile(file, backup, asideTo) {
  const hadFile = existsSync(copyOf(backup));
  if (!hadFile && !existsSync(absentMark(backup))) return { restored: false, setAside: null };

  let setAside = null;
  if (asideTo && existsSync(file)) {
    const now = readFileSync(file);
    if (!hadFile || !now.equals(readFileSync(copyOf(backup)))) {
      mkdirSync(path.dirname(asideTo), { recursive: true });
      writeFileSync(asideTo, now);
      setAside = asideTo;
    }
  }

  // 先放回去、再删备份：万一在这两步之间又被掐掉，下次还能再恢复一遍
  if (hadFile) copyFileSync(copyOf(backup), file);
  else rmSync(file, { force: true });
  rmSync(copyOf(backup), { force: true });
  rmSync(absentMark(backup), { force: true });
  return { restored: true, setAside };
}
