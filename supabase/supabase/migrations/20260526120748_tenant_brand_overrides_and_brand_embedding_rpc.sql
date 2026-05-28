ALTER TABLE app.tenant_brands
  ADD COLUMN IF NOT EXISTS description_override text,
  ADD COLUMN IF NOT EXISTS logo_url_override text;

CREATE OR REPLACE FUNCTION app.refresh_brand_embedding(p_brand_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, catalog
AS $$
BEGIN
  -- Placeholder RPC hook for brand embedding refresh.
  -- Until embedding generation is wired, we explicitly clear the embedding.
  UPDATE catalog.brands
  SET embedding = NULL,
      updated_at = now()
  WHERE id = p_brand_id;
END;
$$;

GRANT EXECUTE ON FUNCTION app.refresh_brand_embedding(uuid) TO authenticated;
