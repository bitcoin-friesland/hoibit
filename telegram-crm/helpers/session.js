export function setStep(session, step) {
  session.step = step;
  session.last_callback_data = null;
}

export function resetSession(session, fields = []) {
  for (const key of fields) {
    delete session[key];
  }
  session.last_callback_data = null;
}

export function updateSession(session, updates = {}) {
  Object.assign(session, updates);
  session.last_callback_data = null;
}
