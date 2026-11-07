import type { ComponentProps, ReactNode } from 'react';

type ToggleProps = Omit<ComponentProps<'input'>, 'type' | 'checked' | 'defaultChecked' | 'onChange'> & {
  label: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
};

export function Toggle({ label, checked, onChange, ...props }: ToggleProps) {
  return (
    <label className="toggle">
      {label}
      <input {...props} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
