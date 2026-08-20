-- Table: public.paymentRequestIds

CREATE TABLE IF NOT EXISTS public."paymentRequestIds"
(
    "paymentRequestId" integer NOT NULL,
    CONSTRAINT "paymentRequestIds_paymentRequestId_pkey" PRIMARY KEY ("paymentRequestId")
)
WITH (
    OIDS = FALSE
)
TABLESPACE pg_default;

ALTER TABLE IF EXISTS public."paymentRequestIds"
    OWNER to postgres;
