'use client';

/**
 * Operator sign-in — spec ADM-002.
 *
 * Three states, because the API has three: a password-only login that
 * succeeds, one that needs an existing TOTP code, and one that needs the
 * operator to enrol a factor first. The enrolment step shows the secret and
 * the otpauth URI, so an authenticator can be set up without a QR code
 * service — which would mean sending the secret to a third party.
 */

import { useCallback, useRef, useState } from 'react';
import { useApp } from '@/lib/app-context';
import { errorMessage } from '@/lib/app-context';
import { ApiRequestError } from '@/lib/api';
import { auth } from '@/lib/endpoints';
import { Button, Field, Input, Note, cx } from './ui';

/**
 * On this screen a 401 means the credentials were wrong, not that a session
 * expired — there is no session yet. The generic mapper cannot know that, so
 * sign-in says it itself. It also does not say *which* field was wrong: that
 * would let anyone test whether an address is an operator account.
 */
function signInError(error: unknown, stage: 'credentials' | 'code'): string {
  if (error instanceof ApiRequestError && error.status === 401) {
    return stage === 'credentials'
      ? 'Неверная почта или пароль'
      : 'Код не принят — попробуйте следующий';
  }
  if (error instanceof ApiRequestError && error.status === 429) {
    return 'Слишком много попыток — подождите и попробуйте снова';
  }
  return errorMessage(error);
}

type Stage =
  | { step: 'credentials' }
  | { step: 'mfa'; mfaToken: string; email: string }
  | { step: 'enroll'; mfaToken: string; email: string; secret: string; uri: string };

export function LoginScreen() {
  const { signIn, toast } = useApp();
  const [stage, setStage] = useState<Stage>({ step: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeField = useRef<HTMLInputElement>(null);

  const complete = useCallback(
    async (token: string, principal: NonNullable<Awaited<ReturnType<typeof auth.login>>['principal']>) => {
      // The login response carries the principal; the permission list comes
      // from /admin/me, which is the thing the API actually enforces against.
      signIn(principal, token, []);
      try {
        const me = await auth.me();
        signIn({ ...principal, roles: me.roles, sellerId: me.sellerId }, token, me.permissions);
      } catch {
        // A failure here leaves the session valid but the UI conservative:
        // `can()` returns false for everything, so nothing is offered that
        // might then be refused.
      }
    },
    [signIn],
  );

  const submitCredentials = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await auth.login(email.trim(), password);
      if (result.status === 'OK' && result.accessToken && result.principal) {
        await complete(result.accessToken, result.principal);
        return;
      }
      if (result.status === 'MFA_ENROLLMENT_REQUIRED' && result.mfaToken && result.enrollment) {
        setStage({
          step: 'enroll',
          mfaToken: result.mfaToken,
          email: email.trim(),
          secret: result.enrollment.secret,
          uri: result.enrollment.uri,
        });
        return;
      }
      if (result.status === 'MFA_REQUIRED' && result.mfaToken) {
        setStage({ step: 'mfa', mfaToken: result.mfaToken, email: email.trim() });
        window.setTimeout(() => codeField.current?.focus(), 50);
        return;
      }
      setError('Неожиданный ответ сервера');
    } catch (caught) {
      setError(signInError(caught, 'credentials'));
    } finally {
      setBusy(false);
    }
  }, [email, password, complete]);

  const submitCode = useCallback(async () => {
    if (stage.step === 'credentials') return;
    setBusy(true);
    setError(null);
    try {
      const result = await auth.verifyMfa(
        stage.mfaToken,
        code.trim(),
        stage.step === 'enroll' ? stage.secret : undefined,
      );
      if (result.accessToken && result.principal) {
        await complete(result.accessToken, result.principal);
        toast('Вход выполнен', 'success');
        return;
      }
      setError('Код не принят');
    } catch (caught) {
      setError(signInError(caught, 'code'));
      setCode('');
      codeField.current?.focus();
    } finally {
      setBusy(false);
    }
  }, [stage, code, complete, toast]);

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <div className="w-full max-w-[380px]">
        <div className="mb-7 text-center">
          <p className="t-display text-[30px] leading-none">Atlas</p>
          <p className="t-eyebrow mt-2">Панель управления</p>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (stage.step === 'credentials') void submitCredentials();
            else void submitCode();
          }}
          className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--bg-raised)] p-5"
        >
          {stage.step === 'credentials' && (
            <div className="space-y-3.5">
              <Field label="Электронная почта">
                <Input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="username"
                  autoFocus
                  required
                />
              </Field>
              <Field label="Пароль">
                <Input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                />
              </Field>
            </div>
          )}

          {stage.step === 'enroll' && (
            <div className="space-y-3.5">
              <Note tone="warn" title="Нужна двухфакторная аутентификация">
                Для вашей роли требуется второй фактор. Добавьте ключ в приложение-аутентификатор
                и введите код.
              </Note>
              <Field
                label="Ключ для аутентификатора"
                hint="Введите вручную или используйте ссылку otpauth://"
              >
                <Input readOnly value={stage.secret} className="t-mono" onFocus={(e) => e.currentTarget.select()} />
              </Field>
              <Field label="otpauth-ссылка">
                <Input readOnly value={stage.uri} className="t-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
              </Field>
              <CodeField value={code} onChange={setCode} inputRef={codeField} />
            </div>
          )}

          {stage.step === 'mfa' && (
            <div className="space-y-3.5">
              <p className="text-[13px] text-[var(--fg-muted)]">
                {stage.email}
              </p>
              <CodeField value={code} onChange={setCode} inputRef={codeField} autoFocus />
            </div>
          )}

          {error && (
            <p className="mt-3 rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            size="md"
            block
            className="mt-4"
            loading={busy}
            disabled={
              stage.step === 'credentials'
                ? !email.trim() || !password
                : code.trim().length < 6
            }
          >
            {stage.step === 'credentials' ? 'Войти' : 'Подтвердить'}
          </Button>

          {stage.step !== 'credentials' && (
            <Button
              variant="ghost"
              block
              className="mt-2"
              onClick={() => {
                setStage({ step: 'credentials' });
                setCode('');
                setError(null);
              }}
            >
              Назад
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}

/** Six digits, one per box, with paste handled — people paste TOTP codes. */
function CodeField({
  value,
  onChange,
  inputRef,
  autoFocus,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
}) {
  return (
    <Field label="Код из приложения" hint="Шесть цифр, обновляются каждые 30 секунд">
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="000000"
        maxLength={6}
        autoFocus={autoFocus}
        className={cx('t-num text-center text-[20px] tracking-[0.35em]')}
      />
    </Field>
  );
}
