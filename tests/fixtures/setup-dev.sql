IF DB_NAME() NOT LIKE N'%[_]PebloyTest'
    THROW 51000, 'Fixture execution requires a disposable database ending in _PebloyTest.', 1;
IF SCHEMA_ID(N'bdeploy_test') IS NULL EXEC(N'CREATE SCHEMA bdeploy_test');
DROP VIEW IF EXISTS bdeploy_test.vw_modified;
DROP PROCEDURE IF EXISTS bdeploy_test.usp_modified;
DROP FUNCTION IF EXISTS bdeploy_test.fn_modified;
DROP SYNONYM IF EXISTS bdeploy_test.syn_test;
DROP SEQUENCE IF EXISTS bdeploy_test.seq_modified;
DROP TABLE IF EXISTS bdeploy_test.tbl_modified;
DROP TABLE IF EXISTS bdeploy_test.tbl_identical;
DROP TABLE IF EXISTS bdeploy_test.tbl_extra_one;
DROP TABLE IF EXISTS bdeploy_test.tbl_extra_two;
IF TYPE_ID(N'bdeploy_test.tt_identical') IS NOT NULL DROP TYPE bdeploy_test.tt_identical;
GO
CREATE TYPE bdeploy_test.tt_identical FROM NVARCHAR(20) NOT NULL;
GO
CREATE TABLE bdeploy_test.tbl_identical (value bdeploy_test.tt_identical NOT NULL);
CREATE TABLE bdeploy_test.tbl_modified (id INT NOT NULL, description NVARCHAR(100) NULL);
CREATE TABLE bdeploy_test.tbl_extra_one (id INT NULL);
CREATE TABLE bdeploy_test.tbl_extra_two (id INT NULL);
INSERT INTO bdeploy_test.tbl_modified (id, description) VALUES (1, N'preserve this row');
CREATE SEQUENCE bdeploy_test.seq_modified AS BIGINT START WITH 100 INCREMENT BY 1;
GO
CREATE VIEW bdeploy_test.vw_modified AS SELECT id, description FROM bdeploy_test.tbl_modified;
GO
CREATE FUNCTION bdeploy_test.fn_modified() RETURNS INT AS BEGIN RETURN 2; END;
GO
CREATE PROCEDURE bdeploy_test.usp_modified AS SELECT N'verbose mode' AS result;
GO
CREATE SYNONYM bdeploy_test.syn_test FOR bdeploy_test.tbl_modified;
GO