import { useState } from 'preact/hooks';
import { auth, logout } from '../lib/auth.js';
import { useStore } from '../lib/store.js';

/** После входа через бота: «Вы вошли как +7 *** **-45-12. Не вы? Выйти» (контракт §14). */
export function SignedInAs({ always = false }) {
  const { status, user, justSignedIn } = useStore(auth);
  const [busy, setBusy] = useState(false);
  if (status !== 'user' || !user?.phone_masked || (!justSignedIn && !always)) return null;
  return (
    <p class="whoami">
      Вы вошли как <span class="mono">{user.phone_masked}</span>. Не вы?{' '}
      <button
        type="button"
        class="btn btn--link whoami__out"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await logout().catch(() => {});
          setBusy(false);
        }}
      >
        Выйти
      </button>
    </p>
  );
}
