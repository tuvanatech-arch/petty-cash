-- 036: Petti's address is https://app.usepetti.com (Netlify), not GitHub Pages: some Namibian mobile networks cannot
-- reach github.io. Sign-in and password-reset emails, the month-end pack email and alert links take the address from
-- settings.app_url. Only an installation still on the old GitHub Pages address is changed.
update public.settings
   set app_url = 'https://app.usepetti.com/', updated_at = now()
 where app_url ilike '%github.io%';
