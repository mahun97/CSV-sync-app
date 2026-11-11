-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RepricerRun" (
    "id" TEXT NOT NULL,
    "slotKey" TEXT,
    "trigger" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "omniaRows" INTEGER NOT NULL DEFAULT 0,
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "clamped" INTEGER NOT NULL DEFAULT 0,
    "ekBlocked" INTEGER NOT NULL DEFAULT 0,
    "notInOmnia" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    CONSTRAINT "RepricerRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepricerEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "sku" TEXT,
    "omniaId" TEXT,
    "variantId" TEXT,
    "productId" TEXT,
    "title" TEXT,
    "omniaPrice" DOUBLE PRECISION,
    "oldPrice" DOUBLE PRECISION,
    "newPrice" DOUBLE PRECISION,
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,
    "ek" DOUBLE PRECISION,
    "message" TEXT,
    CONSTRAINT "RepricerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RepricerRun_slotKey_key" ON "RepricerRun"("slotKey");
CREATE INDEX "RepricerRun_startedAt_idx" ON "RepricerRun"("startedAt");
CREATE INDEX "RepricerEvent_runId_type_idx" ON "RepricerEvent"("runId", "type");
CREATE INDEX "RepricerEvent_sku_idx" ON "RepricerEvent"("sku");

-- AddForeignKey
ALTER TABLE "RepricerEvent" ADD CONSTRAINT "RepricerEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RepricerRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
