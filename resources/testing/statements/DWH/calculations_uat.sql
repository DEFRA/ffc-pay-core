-- Delete existing data if clean environment is required
-- For local development, can also run down docker-compose down -v from ffc-pay-statement-data service to acheive the same
DELETE FROM public.organisations;
DELETE FROM public.fundings;
DELETE FROM public.calculations;

-- Insert organisations, important to note for non production environments, the email address must one setup in our GOV.UK Notify account
INSERT INTO public.organisations (sbi, "addressLine1", "addressLine2", "addressLine3", city, county, postcode, "emailAddress", frn, name, updated)
VALUES
  (106212169,'TWIZELL FARM',null,null,'BELFORD',null,'NE70 7HU','john.watson2@rpa.gov.uk',1102139572,'SH SPOURS AND SONS',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS')),
  (107375830,'The Annex,Cart & Wheel','Craswall',null,'HEREFORD',null,'HR2 0PN','john.watson2@rpa.gov.uk',1100554963,'GJ & JE JONES',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS')),
  (107042416,'THORNE FARM',null,'PETROCKSTOW','OKEHAMPTON',null,'EX20 3EU','john.watson2@rpa.gov.uk',1102369721,'R K H AND J S VOOGHT AND SON',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS')),
  (107382076,'HIGHER CULLEIGH',null,'MONKLEIGH','BIDEFORD',null,'EX39 5LE','john.watson2@rpa.gov.uk',1102515310,'RJ GM & RJ Daniel',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS')),
  (119545874,'Riverside Farm','Heddon Mill',null,'BRAUNTON','Devon','EX33 1HZ','john.watson2@rpa.gov.uk',1100824634,'C R Slade',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS')),
  (107302810,'HIGHER STOCKBRIDGE FARM',null,'STOCKBRIDGE','SHERBORNE',null,'DT9 6EP','john.watson2@rpa.gov.uk',1102379298,'D & J MAPSTONE AND SON',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS')),
  (107702665,'LOWER WATERTOWN FARM','CHITTLEHAMHOLT',null,'UMBERLEIGH','DEVON','EX37 9HF','john.watson2@rpa.gov.uk',1100785647,'G BLANKENBURGS',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS')),
  (106480734,'FLOTTERTON','THROPTON',null,'HEXHAM','NORTHD','NE65 7LF','john.watson2@rpa.gov.uk',1102285668,'FT Walton',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS')),
  (110258388,'Rolle Estate Office','Bicton Arena','East Budleigh','BUDLEIGH SALTERTON','Devon','EX9 7BL','john.watson2@rpa.gov.uk',1101255811,'East Devon Heaths Land Management Company Limited',to_date('30-SEP-22 02:10:40','DD-MON-YY HH:MI:SS'));

-- Insert calculations with calculationId as PK.  All schemes can be hard coded to SFI for now.
INSERT INTO public.calculations ("calculationId" ,sbi ,frn ,"calculationDate" ,"invoiceNumber" ,scheme ,updated)
VALUES
  (103942453,110258388,1101255811,to_date('14-SEP-22 03:04:56','DD-MON-YY HH:MI:SS'),'SFI00793845','80111',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942306,107302810,1102379298,to_date('14-SEP-22 12:24:01','DD-MON-YY HH:MI:SS'),'SFI00793843','80102',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942453,110258388,1101255811,to_date('14-SEP-22 03:04:56','DD-MON-YY HH:MI:SS'),'SFI00793845','80112',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942443,119545874,1100824634,to_date('14-SEP-22 02:29:03','DD-MON-YY HH:MI:SS'),'SFI00793849','80112',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942761,107042416,1102369721,to_date('15-SEP-22 03:07:09','DD-MON-YY HH:MI:SS'),'SFI00793851','80112',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942306,107302810,1102379298,to_date('14-SEP-22 12:24:01','DD-MON-YY HH:MI:SS'),'SFI00793843','80111',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942431,107382076,1102515310,to_date('14-SEP-22 02:11:26','DD-MON-YY HH:MI:SS'),'SFI00793848','80101',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942768,106212169,1102139572,to_date('15-SEP-22 03:30:49','DD-MON-YY HH:MI:SS'),'SFI00793846','80101',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942768,106212169,1102139572,to_date('15-SEP-22 03:30:49','DD-MON-YY HH:MI:SS'),'SFI00793846','80102',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942306,107302810,1102379298,to_date('14-SEP-22 12:24:01','DD-MON-YY HH:MI:SS'),'SFI00793843','80112',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942423,106480734,1102285668,to_date('14-SEP-22 01:33:30','DD-MON-YY HH:MI:SS'),'SFI00793844','80101',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942449,107702665,1100785647,to_date('14-SEP-22 02:36:34','DD-MON-YY HH:MI:SS'),'SFI00793850','80112',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942306,107302810,1102379298,to_date('14-SEP-22 12:24:01','DD-MON-YY HH:MI:SS'),'SFI00793843','80101',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942431,107382076,1102515310,to_date('14-SEP-22 02:11:26','DD-MON-YY HH:MI:SS'),'SFI00793848','80102',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942443,119545874,1100824634,to_date('14-SEP-22 02:29:03','DD-MON-YY HH:MI:SS'),'SFI00793849','80102',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942431,107382076,1102515310,to_date('14-SEP-22 02:11:26','DD-MON-YY HH:MI:SS'),'SFI00793848','80112',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942437,107375830,1100554963,to_date('14-SEP-22 02:23:23','DD-MON-YY HH:MI:SS'),'SFI00793847','80121',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS')),
  (103942449,107702665,1100785647,to_date('14-SEP-22 02:36:34','DD-MON-YY HH:MI:SS'),'SFI00793850','80102',to_date('30-SEP-22 02:03:10','DD-MON-YY HH:MI:SS'));

-- Insert funding with calculationId as FK to calculations table.  One calculation will have 1 or more funding records.
-- There is a PK fundingId field in this table, but it is set to auto increment, so no need to populate it.
-- areaClaimed is set to precision 4dp and rate is 6dp, though current SFI rates are only 2dp, Postgres will automatically add full precision values
INSERT INTO public.fundings ("fundingCode", "calculationId", "areaClaimed", rate)
VALUES
  ('80102',103942443,0.06,40),
  ('80102',103942431,3.06,40),
  ('80101',103942768,74.46,22),
  ('80101',103942306,14.5,22),
  ('80112',103942306,39.91,58),
  ('80111',103942453,33.76,28),
  ('80101',103942431,0.5,22),
  ('80121',103942437,1.34,10.3),
  ('80102',103942449,0.05,40),
  ('80102',103942306,34.71,40),
  ('80111',103942306,15.71,28),
  ('80102',103942768,141.75,40),
  ('80101',103942423,0.54,22),
  ('80112',103942453,48.25,58),
  ('80112',103942431,26.2,58),
  ('80112',103942761,36.72,58),
  ('80112',103942443,7.08,58),
  ('80112',103942449,5.26,58);



