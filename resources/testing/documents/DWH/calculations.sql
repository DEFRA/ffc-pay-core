-- Delete existing data if clean environment is required
-- For local development, can also run down docker-compose down -v from ffc-pay-statement-data service to acheive the same
DELETE FROM public.organisations;
DELETE FROM public.fundings;
DELETE FROM public.calculations;

-- Insert organisations, important to note for non production environments, the email address must one setup in our GOV.UK Notify account
INSERT INTO public.organisations (sbi, "addressLine1", "addressLine2", "addressLine3", city, county, postcode, "emailAddress", frn, name, updated)
VALUES
  (105000001, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000001, 'Mr A Farmer', NOW()),
  (105000002, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000002, 'Mr A Farmer', NOW()),
  (105000003, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000003, 'Mr A Farmer', NOW()),
  (105000004, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000004, 'Mr A Farmer', NOW()),
  (105000005, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000005, 'Mr A Farmer', NOW()),
  (105000006, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000006, 'Mr A Farmer', NOW()),
  (105000007, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000007, 'Mr A Farmer', NOW()),
  (105000008, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000008, 'Mr A Farmer', NOW()),
  (105000009, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000009, 'Mr A Farmer', NOW()),
  (105000010, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000010, 'Mr A Farmer', NOW()),
  (105000011, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000011, 'Mr A Farmer', NOW()),
  (105000012, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000012, 'Mr A Farmer', NOW()),
  (105000013, 'A Farm', 'A Place', 'A Land', 'A City', 'A County', 'NE1 2FA', 'john.watson2@rpa.gov.uk', 1000000013, 'Mr A Farmer', NOW());

-- Insert calculations with calculationId as PK.  All schemes can be hard coded to SFI for now.
INSERT INTO public.calculations ("calculationId" ,sbi ,frn ,"calculationDate" ,"invoiceNumber" ,scheme ,updated)
VALUES
(1000001, 105000001, 1000000001, NOW(), 'SFI0000001', 'SFI', NOW()),
(1000002, 105000002, 1000000002, NOW(), 'SFI0000002', 'SFI', NOW()),
(1000003, 105000003, 1000000003, NOW(), 'SFI0000003', 'SFI', NOW()),
(1000004, 105000004, 1000000004, NOW(), 'SFI0000004', 'SFI', NOW()),
(1000005, 105000005, 1000000005, NOW(), 'SFI0000005', 'SFI', NOW()),
(1000006, 105000006, 1000000006, NOW(), 'SFI0000006', 'SFI', NOW()),
(1000007, 105000007, 1000000007, NOW(), 'SFI0000007', 'SFI', NOW()),
(1000008, 105000008, 1000000008, NOW(), 'SFI0000008', 'SFI', NOW()),
(1000009, 105000009, 1000000009, NOW(), 'SFI0000009', 'SFI', NOW()),
(1000010, 105000010, 1000000010, NOW(), 'SFI0000010', 'SFI', NOW()),
(1000011, 105000011, 1000000011, NOW(), 'SFI0000011', 'SFI', NOW()),
(1000012, 105000012, 1000000012, NOW(), 'SFI0000012', 'SFI', NOW()),
(1000013, 105000013, 1000000013, NOW(), 'SFI0000013', 'SFI', NOW());

-- Insert funding with calculationId as FK to calculations table.  One calculation will have 1 or more funding records.
-- There is a PK fundingId field in this table, but it is set to auto increment, so no need to populate it.
-- areaClaimed is set to precision 4dp and rate is 6dp, though current SFI rates are only 2dp, Postgres will automatically add full precision values
INSERT INTO public.fundings ("fundingCode", "calculationId", "areaClaimed", rate)
VALUES
  ('80101', 1000001, 1000, 22),
  ('80102', 1000002, 1000, 40),
  ('80111', 1000003, 1000, 28),
  ('80112', 1000004, 1000, 58),
  ('80101', 1000005, 1000, 22),
  ('80102', 1000005, 1000, 40),
  ('80111', 1000006, 1000, 28),
  ('80112', 1000006, 1000, 58),
  ('80101', 1000007, 1000, 22),
  ('80102', 1000007, 1000, 40),
  ('80111', 1000007, 1000, 28),
  ('80112', 1000007, 1000, 58),
  ('80121', 1000008, 1000, 10.30),
  ('80190', 1000008, 250, 0),
  ('80101', 1000009, 1000, 22),
  ('80121', 1000009, 1000, 10.30),
  ('80190', 1000009, 250, 0),
  ('80195', 1000010, 1000, 6.15),
  ('80101', 1000011, 1000, 22),
  ('80195', 1000011, 1000, 6.15),
  ('80121', 1000012, 1000, 10.30),
  ('80190', 1000012, 250, 0),
  ('80195', 1000012, 1000, 6.15),
  ('80101', 1000013, 1000, 22),
  ('80102', 1000013, 1000, 40),
  ('80111', 1000013, 1000, 28),
  ('80112', 1000013, 1000, 58),
  ('80121', 1000013, 1000, 10.30),
  ('80190', 1000013, 250, 0),
  ('80195', 1000013, 1000, 6.15)
