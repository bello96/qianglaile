import type { ButtonHTMLAttributes } from 'react';
import { sfx } from '../audio';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 主按钮（珊瑚红） */
  go?: boolean;
  /** 特大号：给举手悬停用，三米外也点得中 */
  xl?: boolean;
  /** 小号的工具按钮 */
  icon?: boolean;
  /** 允许举手悬停点击；值是这个按钮的唯一名字 */
  air?: string;
}

export function Button({ go, xl, icon, air, className, onClick, ...rest }: Props) {
  const classes = ['btn', go && 'btn--go', xl && 'btn--xl', icon && 'btn--icon', className].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      className={classes}
      data-air={air}
      onClick={(e) => {
        sfx.play('click');
        onClick?.(e);
      }}
      {...rest}
    />
  );
}
