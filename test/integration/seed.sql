-- Seed for pipeline integration tests. Run by globalSetup.ts; batches split on lines that are exactly GO.
-- $(BIG_ROWS) is substituted with TABLEDIFF_BIG_ROWS (default 3000000).
-- All datetime values are whole seconds (datetime rounds to 1/300 s).

IF DB_ID('tablediff_a') IS NOT NULL ALTER DATABASE tablediff_a SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
GO
DROP DATABASE IF EXISTS tablediff_a;
GO
IF DB_ID('tablediff_b') IS NOT NULL ALTER DATABASE tablediff_b SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
GO
DROP DATABASE IF EXISTS tablediff_b;
GO
CREATE DATABASE tablediff_a;
GO
CREATE DATABASE tablediff_b;
GO
ALTER DATABASE tablediff_a SET RECOVERY SIMPLE;
ALTER DATABASE tablediff_b SET RECOVERY SIMPLE;
GO

---------------------------------------------------------------------------- orders (left)
USE tablediff_a;
GO
CREATE TABLE dbo.orders (
  order_id int NOT NULL,
  status varchar(20) NULL,
  amount decimal(10,2) NULL,
  created datetime NULL,
  note nvarchar(max) NULL,
  code char(5) NULL,
  qty varchar(10) NULL,
  legacy_flag bit NULL
);
GO
WITH n AS (
  SELECT TOP (50000) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS int) AS n
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO dbo.orders WITH (TABLOCK) (order_id, status, amount, created, note, code, qty, legacy_flag)
SELECT
  n,
  CASE n % 3 WHEN 0 THEN 'Open' WHEN 1 THEN 'Closed' ELSE 'Shipped' END,
  CAST((n % 10000) / 100.0 AS decimal(10,2)),
  DATEADD(second, n, CAST('2020-01-01T00:00:00' AS datetime)),
  CASE WHEN n % 7 = 0 THEN NULL ELSE N'note ' + CAST(n AS nvarchar(10)) END,
  'C' + CAST(n % 100 AS varchar(3)),
  CAST(n % 50 AS varchar(10)),
  CAST(n % 2 AS bit)
FROM n;
GO
UPDATE dbo.orders SET amount = 1.23 WHERE order_id = 200;
UPDATE dbo.orders SET note = NULL WHERE order_id = 300;
UPDATE dbo.orders SET status = 'Open' WHERE order_id = 400;
UPDATE dbo.orders SET note = N'x' WHERE order_id = 500;
GO
SELECT * INTO dbo.orders_copy FROM dbo.orders;
GO

---------------------------------------------------------------------------- orders (right)
USE tablediff_b;
GO
CREATE TABLE dbo.orders (
  ORDER_ID int NOT NULL,
  status nvarchar(20) NULL,
  amount decimal(12,4) NULL,
  created datetime2(7) NULL,
  note nvarchar(max) NULL,
  code varchar(5) NULL,
  qty int NULL,
  region varchar(10) NULL
);
GO
INSERT INTO dbo.orders WITH (TABLOCK) (ORDER_ID, status, amount, created, note, code, qty, region)
SELECT order_id, status, amount, created, note, RTRIM(code), CAST(qty AS int), 'R' + CAST(order_id % 5 AS varchar(2))
FROM tablediff_a.dbo.orders
WHERE order_id NOT BETWEEN 10 AND 19;
GO
INSERT INTO dbo.orders (ORDER_ID, status, amount, created, note, code, qty, region)
VALUES
  (50001, N'Open', 1.0000, '2021-01-01T00:00:01', N'new 1', 'N1', 1, 'R1'),
  (50002, N'Open', 2.0000, '2021-01-01T00:00:02', N'new 2', 'N2', 2, 'R2'),
  (50003, N'Open', 3.0000, '2021-01-01T00:00:03', NULL,     'N3', 3, 'R3'),
  (50004, N'Open', 4.0000, '2021-01-01T00:00:04', N'new 4', 'N4', 4, 'R4'),
  (50005, N'Open', 5.0000, '2021-01-01T00:00:05', N'new 5', 'N5', 5, 'R0');
GO
UPDATE dbo.orders SET status = N'Cancelled' WHERE ORDER_ID BETWEEN 100 AND 149;
UPDATE dbo.orders SET amount = 1.24 WHERE ORDER_ID = 200;
UPDATE dbo.orders SET note = N'' WHERE ORDER_ID = 300;
UPDATE dbo.orders SET status = N'OPEN' WHERE ORDER_ID = 400;
UPDATE dbo.orders SET note = N'x ' WHERE ORDER_ID = 500;
GO

---------------------------------------------------------------------------- lines
-- 99 shared keys: order_id 1..33 x line_no 1..3.
-- Left: plus a second (1,1) row. Right: plus (50, NULL). Key (2,1) has a different sku.
USE tablediff_a;
GO
CREATE TABLE dbo.lines (order_id int NULL, line_no int NULL, sku varchar(10) NULL);
GO
WITH o AS (
  SELECT TOP (33) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS int) AS o FROM sys.all_objects
), l AS (
  SELECT 1 AS l UNION ALL SELECT 2 UNION ALL SELECT 3
)
INSERT INTO dbo.lines (order_id, line_no, sku)
SELECT o, l, 'S' + CAST(o * 10 + l AS varchar(8)) FROM o CROSS JOIN l;
INSERT INTO dbo.lines (order_id, line_no, sku) VALUES (1, 1, 'DUP');
GO
USE tablediff_b;
GO
CREATE TABLE dbo.lines (order_id int NULL, line_no int NULL, sku varchar(10) NULL);
GO
INSERT INTO dbo.lines (order_id, line_no, sku)
SELECT order_id, line_no, sku FROM tablediff_a.dbo.lines WHERE NOT (order_id = 1 AND line_no = 1 AND sku = 'DUP');
UPDATE dbo.lines SET sku = 'CHANGED' WHERE order_id = 2 AND line_no = 1;
INSERT INTO dbo.lines (order_id, line_no, sku) VALUES (50, NULL, 'NULLKEY');
GO

---------------------------------------------------------------------------- odd name]x, empty_t, empty_both
USE tablediff_a;
GO
CREATE TABLE dbo.[odd name]]x] ([it's] int NULL, val nvarchar(10) NULL);
INSERT INTO dbo.[odd name]]x] ([it's], val) VALUES (1, N'a'), (2, N'b'), (3, NULL);
CREATE TABLE dbo.empty_t (id int NULL, v int NULL);
CREATE TABLE dbo.empty_both (id int NULL, v int NULL);
GO
USE tablediff_b;
GO
CREATE TABLE dbo.[odd name]]x] ([it's] int NULL, val nvarchar(10) NULL);
INSERT INTO dbo.[odd name]]x] ([it's], val) VALUES (1, N'a'), (2, N'b'), (3, NULL);
CREATE TABLE dbo.empty_t (id int NULL, v int NULL);
INSERT INTO dbo.empty_t (id, v) VALUES (1, 10), (2, 20), (3, 30);
CREATE TABLE dbo.empty_both (id int NULL, v int NULL);
GO

---------------------------------------------------------------------------- wide
-- id + 250 bigint columns c001..c250 with 15-digit values: the row-hash segments total ~4,750 characters,
-- more than nvarchar(4000). Only c250 (last in hash order) differs, for id = 1.
USE tablediff_a;
GO
DECLARE @i int = 1, @create nvarchar(max) = N'CREATE TABLE dbo.wide (id int NOT NULL',
  @ins nvarchar(max) = N'INSERT INTO dbo.wide SELECT n';
WHILE @i <= 250
BEGIN
  SET @create += N', c' + RIGHT(N'00' + CAST(@i AS nvarchar(3)), 3) + N' bigint NULL';
  SET @ins += N', 100000000000000 + ' + CAST(@i AS nvarchar(3)) + N' * 1000 + n';
  SET @i += 1;
END;
SET @create += N');';
SET @ins += N' FROM (VALUES (1), (2), (3)) AS v(n);';
EXEC (@create);
EXEC (@ins);
GO
USE tablediff_b;
GO
SELECT * INTO dbo.wide FROM tablediff_a.dbo.wide;
UPDATE dbo.wide SET c250 = c250 + 1 WHERE id = 1;
GO

---------------------------------------------------------------------------- types_t
-- Display values (decimal, datetime2(7), date, time, datetimeoffset) and smalldatetime vs datetime2 rounding.
-- Only id = 1 differs (marker). Rows 2-5 store sdt as smalldatetime on the left (SQL Server rounds to the
-- nearest minute) and the unrounded datetime2 value on the right: no difference.
USE tablediff_a;
GO
CREATE TABLE dbo.types_t (
  id int NOT NULL, d decimal(38,10) NULL, dt2 datetime2(7) NULL, dd date NULL, tt time(7) NULL,
  dto datetimeoffset(7) NULL, sdt smalldatetime NULL, marker int NULL
);
INSERT INTO dbo.types_t (id, d, dt2, dd, tt, dto, sdt, marker) VALUES
  (1, 1234567890123456789.0123456789, '2020-01-02T03:04:05.1234567', '2020-01-02', '03:04:05.1234567',
   '2020-01-02T03:04:05.1234567+05:30', '2020-01-01T12:35:00', 1),
  (2, 1, NULL, NULL, NULL, NULL, '2020-01-01T12:35:45', 0),
  (3, 1, NULL, NULL, NULL, NULL, '2020-01-01T12:35:29', 0),
  (4, 1, NULL, NULL, NULL, NULL, '2020-01-01T12:35:30', 0),
  (5, 1, NULL, NULL, NULL, NULL, '2020-01-01T23:59:59', 0);
GO
USE tablediff_b;
GO
CREATE TABLE dbo.types_t (
  id int NOT NULL, d decimal(38,10) NULL, dt2 datetime2(7) NULL, dd date NULL, tt time(7) NULL,
  dto datetimeoffset(7) NULL, sdt datetime2(7) NULL, marker int NULL
);
INSERT INTO dbo.types_t (id, d, dt2, dd, tt, dto, sdt, marker) VALUES
  (1, 1234567890123456789.0123456789, '2020-01-02T03:04:05.1234567', '2020-01-02', '03:04:05.1234567',
   '2020-01-02T03:04:05.1234567+05:30', '2020-01-01T12:35:00', 2),
  (2, 1, NULL, NULL, NULL, NULL, '2020-01-01T12:35:45.1234567', 0),
  (3, 1, NULL, NULL, NULL, NULL, '2020-01-01T12:35:29.9999999', 0),
  (4, 1, NULL, NULL, NULL, NULL, '2020-01-01T12:35:30', 0),
  (5, 1, NULL, NULL, NULL, NULL, '2020-01-01T23:59:59', 0);
GO

---------------------------------------------------------------------------- big
USE tablediff_a;
GO
CREATE TABLE dbo.big (id bigint NOT NULL, v int NULL, w varchar(20) NULL);
GO
WITH n AS (
  SELECT TOP ($(BIG_ROWS)) CAST(ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS bigint) AS n
  FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c
)
INSERT INTO dbo.big WITH (TABLOCK) (id, v, w)
SELECT n, CAST(n % 997 AS int), 'w' + CAST(n % 100000 AS varchar(10)) FROM n;
GO
USE tablediff_b;
GO
CREATE TABLE dbo.big (id bigint NOT NULL, v int NULL, w varchar(20) NULL);
GO
INSERT INTO dbo.big WITH (TABLOCK) (id, v, w)
SELECT id, CASE WHEN id % 3000 = 7 THEN v + 1 ELSE v END, w FROM tablediff_a.dbo.big;
GO
USE master;
GO
