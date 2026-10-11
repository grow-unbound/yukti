import { YuktiLogo } from '@/components/brand/YuktiLogo';
import { AUTH_LOGIN_COPY } from '@/constants/auth-login-copy';

export function AuthHomeLogoLink() {
  return (
    <a
      href={AUTH_LOGIN_COPY.login.homeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex opacity-90 transition-opacity hover:opacity-100"
      aria-label="Yukti home"
    >
      <YuktiLogo variant="stacked-lockup" className="h-14 w-[76px]" priority />
    </a>
  );
}
