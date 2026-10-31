-- (runs before 022: the new kinds must exist before 022 uses them)
-- 022a: cash short or over at a signed-off count, written off by the GM (amounts stay positive; the kind gives the direction).
-- Run on its own before 022: a new enum value cannot be used in the transaction that adds it.
alter type public.float_tx_kind add value if not exists 'shortage';
alter type public.float_tx_kind add value if not exists 'surplus';
