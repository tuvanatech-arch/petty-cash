-- (runs before 043: the new kinds must exist before 043 uses them)
-- Petty cash held in two places, the cash box and the petty cash bank account: money moved between them.
--   withdrawal: cash taken out of the petty cash bank account into the box
--   deposit:    cash from the box paid into the petty cash bank account
-- Run on its own before 043: a new enum value cannot be used in the transaction that adds it.
alter type public.float_tx_kind add value if not exists 'withdrawal';
alter type public.float_tx_kind add value if not exists 'deposit';
