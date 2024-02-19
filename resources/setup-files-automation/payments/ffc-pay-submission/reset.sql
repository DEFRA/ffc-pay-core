TRUNCATE TABLE public."batches" RESTART IDENTITY CASCADE;

UPDATE public."sequences"
SET "nextAP" = 1, "nextAR" = 1;
