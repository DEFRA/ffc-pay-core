TRUNCATE TABLE public.organisations RESTART IDENTITY CASCADE;
TRUNCATE TABLE public.calculations RESTART IDENTITY CASCADE;

-- Delete existing data if clean environment is required
-- For local development, can also run down docker-compose down -v from ffc-pay-statement-data service to acheive the same
DELETE FROM public.organisations;
DELETE FROM public.fundings;
DELETE FROM public.calculations;

-- Insert organisations, important to note for non production environments, the email address must one setup in our GOV.UK Notify account
INSERT INTO public.organisations (sbi, "addressLine1", "addressLine2", "addressLine3", city, county, postcode, "emailAddress", frn, name, updated)
VALUES
(110100001,'A farm','A field','A place','A town','A county','FA1 2PY','123.123@123.com',1000000001,'Mr Unsettled Top Up',NOW()),
(110100002,'A farm','A field','A place','A town','A county','FA1 2PY','123.123@123.com',1000000002,'Mr Settled Top Up',NOW()),
(110100003,'A farm','A field','A place','A town','A county','FA1 2PY','123.123@123.com',1000000003,'Mr Settled Reduction',NOW()),
(110100004,'A farm','A field','A place','A town','A county','FA1 2PY','123.123@123.com',1000000004,'Mr Unsettled Reduction',NOW()),
(110100005,'A farm','A field','A place','A town','A county','FA1 2PY','123.123@123.com',1000000005,'Mr Recovery',NOW()),
(110100006,'A farm','A field','A place','A town','A county','FA1 2PY','123.123@123.com',1000000006,'Mr Zero Value Split',NOW());


-- Insert calculations with calculationId as PK.  All schemes can be hard coded to SFI for now.
INSERT INTO public.calculations ("calculationId" ,sbi ,frn ,"calculationDate" ,"invoiceNumber" ,scheme ,updated)
VALUES
(10001,110100001,1000000001,NOW(),'SFI00000001','80101',NOW()),
(10002,110100002,1000000002,NOW(),'SFI00000002','80101',NOW()),
(10003,110100003,1000000003,NOW(),'SFI00000003','80101',NOW()),
(10004,110100004,1000000004,NOW(),'SFI00000004','80101',NOW()),
(10005,110100005,1000000005,NOW(),'SFI00000005','80101',NOW()),
(10006,110100001,1000000001,NOW(),'SFI00000006','80101',NOW()),

(10007,110100001,1000000001,NOW(),'SFI00000007','80101',NOW()),
(10008,110100002,1000000002,NOW(),'SFI00000008','80101',NOW()),
(10009,110100003,1000000003,NOW(),'SFI00000009','80101',NOW()),
(10010,110100004,1000000004,NOW(),'SFI00000010','80101',NOW()),
(10011,110100005,1000000005,NOW(),'SFI00000011','80101',NOW()),
(10012,110100006,1000000006,NOW(),'SFI00000012','80102',NOW()),

(10013,110100001,1000000001,NOW(),'SFI00000013','80101',NOW()),
(10014,110100002,1000000002,NOW(),'SFI00000014','80101',NOW()),
(10015,110100003,1000000003,NOW(),'SFI00000015','80101',NOW()),
(10016,110100004,1000000004,NOW(),'SFI00000016','80101',NOW()),
(10017,110100005,1000000005,NOW(),'SFI00000017','80101',NOW()),
(10018,110100006,1000000006,NOW(),'SFI00000018','80102',NOW());

-- Insert funding with calculationId as FK to calculations table.  One calculation will have 1 or more funding records.
-- There is a PK fundingId field in this table, but it is set to auto increment, so no need to populate it.
-- areaClaimed is set to precision 4dp and rate is 6dp, though current SFI rates are only 2dp, Postgres will automatically add full precision values
INSERT INTO public.fundings ("fundingCode", "calculationId", "areaClaimed", rate)
VALUES
('80101',10001,45.4545,22),
('80101',10002,45.4545,22),
('80101',10003,45.4545,22),
('80101',10004,45.4545,22),
('80101',10005,45.4545,22),
('80101',10006,45.4545,22),

('80101',10007,68.1818,22),
('80101',10008,68.1818,22),
('80101',10009,22.7272,22),
('80101',10010,22.7272,22),
('80101',10011,22.7272,22),
('80102',10012,35.7142,28),

('80101',10013,136.3636,22),
('80101',10014,136.3636,22),
('80101',10015,136.3636,22),
('80101',10016,136.3636,22),
('80101',10017,136.3636,22),
('80102',10018,107.1428,28);
