-- Run this against the SOURCE database you want to pull from.
-- It ensures the source table has a primary key, unique constraint, foreign key,
-- index and some rows, so the local transfer test can verify schema preservation.

-- Example for ffc-pay-alerting-prd / recovery. Adjust schema/database as needed.
CREATE TABLE IF NOT public.parent_records (
    parent_id bigint PRIMARY KEY,
    parent_name character varying(100) NOT NULL
);

CREATE TABLE IF NOT public.child_records (
    child_id bigint PRIMARY KEY,
    parent_id bigint NOT NULL,
    child_name character varying(100) NOT NULL,
    child_code character varying(50),
    CONSTRAINT fk_child_parent FOREIGN KEY (parent_id) REFERENCES public.parent_records(parent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_child_code_unique ON public.child_records(child_code);
CREATE INDEX IF NOT EXISTS idx_child_name ON public.child_records(child_name);

TRUNCATE TABLE public.child_records CASCADE;
TRUNCATE TABLE public.parent_records CASCADE;

INSERT INTO public.parent_records (parent_id, parent_name) VALUES
    (1, 'Parent One'),
    (2, 'Parent Two')
ON CONFLICT (parent_id) DO NOTHING;

INSERT INTO public.child_records (child_id, parent_id, child_name, child_code) VALUES
    (101, 1, 'Child A', 'CHILD-A'),
    (102, 1, 'Child B', 'CHILD-B'),
    (103, 2, 'Child C', 'CHILD-C')
ON CONFLICT (child_id) DO NOTHING;
