import type { ComponentProps } from 'react';

type ButtonProps = ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'join' | 'danger' };
const classes = { primary: 'go', secondary: 'btn2', join: 'join', danger: 'btn2 danger' };

/** Existing text-button appearances. Forms opt into type="submit" explicitly. */
export function Button({ variant = 'secondary', className = '', type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={`${classes[variant]}${className ? ` ${className}` : ''}`} {...props} />;
}
