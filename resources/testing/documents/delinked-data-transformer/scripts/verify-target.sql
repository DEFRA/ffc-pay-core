-- Run this against the local target database after transfer to confirm everything survived.

-- 1. Confirm tables exist and have rows.
SELECT 'parent_records' AS table_name, COUNT(*) AS row_count FROM public.parent_records
UNION ALL
SELECT 'child_records', COUNT(*) FROM public.child_records;

-- 2. Confirm primary keys survived.
SELECT
    tc.table_name,
    tc.constraint_name,
    tc.constraint_type
FROM information_schema.table_constraints tc
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'PRIMARY KEY'
ORDER BY tc.table_name;

-- 3. Confirm foreign keys survived.
SELECT
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name,
    tc.constraint_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public';

-- 4. Confirm indexes survived.
SELECT
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- 5. Confirm unique constraints survived.
SELECT
    tc.table_name,
    tc.constraint_name
FROM information_schema.table_constraints tc
WHERE tc.table_schema = 'public'
  AND tc.constraint_type = 'UNIQUE'
ORDER BY tc.table_name;

-- 6. Confirm managed identity has grants on the transferred tables.
SELECT
    grantee,
    table_name,
    privilege_type
FROM information_schema.table_privileges
WHERE grantee = 'devffcinfdmid01'
  AND table_schema = 'public'
ORDER BY table_name, privilege_type;
