import type { Session } from "../types";

export function setStep(session: Session, step: string) {
  session.step = step;
  session.last_callback_data = null;
}
