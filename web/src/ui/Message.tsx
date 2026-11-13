import { Orb } from './Orb';
import './Message.css';

export function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="screen center">
      <div className="message-screen">
        <Orb seed="message" palette="sky" />
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
    </div>
  );
}
