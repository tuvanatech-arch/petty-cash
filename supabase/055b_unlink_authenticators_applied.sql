-- 055b: the authenticator app is gone (051), but an authenticator linked before then still makes Supabase refuse a
-- password change ("AAL2 session is required"). Unlink every leftover authenticator.
delete from auth.mfa_factors where factor_type = 'totp';
