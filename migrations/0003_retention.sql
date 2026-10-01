-- 摘要的保存天數改看「寫入摘要的時間」。原本看 targets.updated_at，按「換一批」或重貼同一個網址都會更新它，
-- 摘要可以一直續命，跟隱私權政策寫的 30 天對不上。
ALTER TABLE targets ADD COLUMN summary_at INTEGER;

-- 舊資料：用最後更新時間當起點（保守：不會讓舊摘要多活）
UPDATE targets SET summary_at = updated_at WHERE summary IS NOT NULL AND summary_at IS NULL;
