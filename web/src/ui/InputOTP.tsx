import { OTPInput, REGEXP_ONLY_DIGITS, type OTPInputProps } from 'input-otp';
import './InputOTP.css';

export function InputOTP({ containerClassName = '', ...props }: Omit<OTPInputProps, 'render' | 'children'>) {
  return <OTPInput pattern={REGEXP_ONLY_DIGITS} inputMode="numeric" autoComplete="one-time-code"
    containerClassName={`input-otp ${containerClassName}`} {...props}
    render={({ slots }) => <div className="input-otp-group" aria-hidden="true">
      {slots.map((slot, index) => <span key={index} className="input-otp-slot" data-active={slot.isActive || undefined}>
        {slot.char}{slot.hasFakeCaret && <span className="input-otp-caret" />}
      </span>)}
    </div>} />;
}
