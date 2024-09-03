TRUNCATE TABLE public.organisations RESTART IDENTITY CASCADE;
TRUNCATE TABLE public.delinkedCalculation RESTART IDENTITY CASCADE;
-- Delete existing data if clean environment is required
-- For local development, can also run down docker compose down -v from ffc-pay-statement-data service to acheive the same
DELETE FROM public.organisations;
DELETE FROM public.calculations;
-- Insert organisations, important to note for non production environments, the email address must one setup in our GOV.UK Notify account
INSERT INTO public.organisations (
    sbi,
    "addressLine1",
    "addressLine2",
    "addressLine3",
    city,
    county,
    postcode,
    "emailAddress",
    frn,
    name,
    updated
  )
VALUES (
    110100001,
    'A farm',
    'A field',
    'A place',
    'A town',
    'A county',
    'FA1 2PY',
    '123.123@123.com',
    1000000001,
    'Mr Unsettled Top Up',
    NOW()
  ),
  (
    110100002,
    'A farm',
    'A field',
    'A place',
    'A town',
    'A county',
    'FA1 2PY',
    '123.123@123.com',
    1000000002,
    'Mr Settled Top Up',
    NOW()
  ),
  (
    110100003,
    'A farm',
    'A field',
    'A place',
    'A town',
    'A county',
    'FA1 2PY',
    '123.123@123.com',
    1000000003,
    'Mr Settled Reduction',
    NOW()
  ),
  (
    110100004,
    'A farm',
    'A field',
    'A place',
    'A town',
    'A county',
    'FA1 2PY',
    '123.123@123.com',
    1000000004,
    'Mr Unsettled Reduction',
    NOW()
  ),
  (
    110100005,
    'A farm',
    'A field',
    'A place',
    'A town',
    'A county',
    'FA1 2PY',
    '123.123@123.com',
    1000000005,
    'Mr Recovery',
    NOW()
  ),
  (
    110100006,
    'A farm',
    'A field',
    'A place',
    'A town',
    'A county',
    'FA1 2PY',
    '123.123@123.com',
    1000000006,
    'Mr Zero Value Split',
    NOW()
  );