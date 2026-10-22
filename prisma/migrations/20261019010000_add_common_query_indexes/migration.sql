CREATE INDEX "streams_created_at_idx" ON "streams"("created_at");
CREATE INDEX "streams_status_idx" ON "streams"("status");
CREATE INDEX "streams_token_address_idx" ON "streams"("token_address");
CREATE INDEX "streams_ngo_id_created_at_idx" ON "streams"("ngo_id", "created_at");
CREATE INDEX "ngos_created_at_idx" ON "ngos"("created_at");
CREATE INDEX "ngos_verified_idx" ON "ngos"("verified");
CREATE INDEX "ngo_applications_created_at_idx" ON "ngo_applications"("created_at");
CREATE INDEX "stream_events_stream_id_created_at_idx" ON "stream_events"("stream_id", "created_at");
