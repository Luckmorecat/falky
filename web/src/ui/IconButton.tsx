import type { ComponentProps } from 'react';

type IconButtonProps = ComponentProps<'button'> & { size?: 'regular' | 'small'; 'aria-label': string };

/** Keeps icon content, tooltips, pressed state and feature-specific classes at the call site. */
export function IconButton({ size = 'regular', className = '', type = 'button', ...props }: IconButtonProps) {
  return <button type={type} className={`ib${size === 'small' ? ' sm' : ''}${className ? ` ${className}` : ''}`} {...props} />;
}
