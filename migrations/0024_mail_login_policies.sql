-- Publish 1.2 without modifying historical acceptance or notice receipts.
INSERT INTO policy_documents(id,kind,version,locale,effective_at,content_hash,current) VALUES
  ('terms-1.2','terms','1.2','zh-CN','2026-10-23','2b8f728b467b1d0e6bb43c27c3193ea3aec58a5274c79a7dc5183c72e81e1160',0),
  ('privacy-1.2','privacy','1.2','zh-CN','2026-10-23','a744cbba70b8661ae5188abe5abb5443b4c74c84016b9278a672224281f1870a',0);
UPDATE policy_documents SET current=CASE WHEN id IN ('terms-1.2','privacy-1.2') THEN 1 ELSE 0 END WHERE kind IN ('terms','privacy') AND locale='zh-CN';
