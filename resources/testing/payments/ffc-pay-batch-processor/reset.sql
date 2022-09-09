UPDATE public."sequences"
SET "next" = 1;

TRUNCATE TABLE public.batches RESTART IDENTITY CASCADE;
