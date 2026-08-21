-- Table: public.manualVerificationQueue

CREATE TABLE IF NOT EXISTS public."manualVerificationQueue"
(
    "paymentRequestId" integer NOT NULL,
    "foundInInvoiceLines" boolean DEFAULT false,
    "foundInCompletedPaymentRequests" boolean DEFAULT false,
    "foundInSchedule" boolean DEFAULT false,
    "foundInCompletedInvoiceLines" boolean DEFAULT false,
    "foundInOutbox" boolean DEFAULT false,
    status character varying(20) COLLATE pg_catalog."default" DEFAULT 'PENDING'::character varying,
    "createdAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "manualVerificationQueue_pkey" PRIMARY KEY ("paymentRequestId")
)
WITH (
    OIDS = FALSE
)
TABLESPACE pg_default;

ALTER TABLE IF EXISTS public."manualVerificationQueue"
    OWNER to postgres;

CREATE INDEX IF NOT EXISTS "idx_manualVerificationQueue_status"
    ON public."manualVerificationQueue" USING btree
    (status COLLATE pg_catalog."default" ASC NULLS LAST)
    WITH (fillfactor=100)
    TABLESPACE pg_default;
