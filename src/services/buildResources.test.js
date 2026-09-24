const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("app-builder-lib/out/toolsets/icons", () => ({ runIconsTool: jest.fn() }));
jest.mock("app-builder-lib/out/util/iconConverter", () => ({ convertIcon: jest.fn() }));

const { runIconsTool } = require("app-builder-lib/out/toolsets/icons");
const { convertIcon } = require("app-builder-lib/out/util/iconConverter");
const { ensureAppIcon } = require("../../scripts/prepare-resources");

let root;
let staging;

beforeEach(() => {
  jest.resetAllMocks();
  staging = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pebloy-icon-test-"));
  fs.mkdirSync(path.join(root, "public"));
  fs.mkdirSync(path.join(root, "build"));
  fs.writeFileSync(path.join(root, "public", "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, "public", "logo.png"), "old PNG");
  fs.writeFileSync(path.join(root, "build", "icon.ico"), "old ICO");
  runIconsTool.mockImplementation(async ({ outDir }) => {
    staging = outDir;
    fs.writeFileSync(path.join(outDir, "512x512.png"), "new PNG");
  });
  convertIcon.mockImplementation(async ({ outDir }) => {
    const icon = path.join(outDir, "icon.ico");
    fs.writeFileSync(icon, "new ICO");
    return { icons: [{ file: icon, size: 256 }] };
  });
});

afterEach(() => {
  if (staging) expect(fs.existsSync(staging)).toBe(false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("regenerates existing PNG and ICO from the same SVG master", async () => {
  await ensureAppIcon(root);
  const source = path.join(root, "public", "logo.svg");
  expect(runIconsTool).toHaveBeenCalledWith({ inputFile: source, outputFormat: "set", outDir: staging });
  expect(convertIcon).toHaveBeenCalledWith({ sources: [source], fallbackSources: [], roots: [root], format: "ico", outDir: staging });
  expect(fs.readFileSync(path.join(root, "public", "logo.png"), "utf8")).toBe("new PNG");
  expect(fs.readFileSync(path.join(root, "build", "icon.ico"), "utf8")).toBe("new ICO");
});

test("keeps previous assets intact and fails when conversion fails", async () => {
  convertIcon.mockRejectedValueOnce(new Error("Icon conversion failed"));
  await expect(ensureAppIcon(root)).rejects.toThrow("Icon conversion failed");
  expect(fs.readFileSync(path.join(root, "public", "logo.png"), "utf8")).toBe("old PNG");
  expect(fs.readFileSync(path.join(root, "build", "icon.ico"), "utf8")).toBe("old ICO");
});

test("does not accept a stale icon when no new icon was produced", async () => {
  convertIcon.mockResolvedValueOnce({ icons: [] });
  await expect(ensureAppIcon(root)).rejects.toThrow("Could not generate the PNG and Windows icon");
  expect(fs.readFileSync(path.join(root, "build", "icon.ico"), "utf8")).toBe("old ICO");
});

test("requires the vector master even when previous raster assets exist", async () => {
  fs.unlinkSync(path.join(root, "public", "logo.svg"));
  await expect(ensureAppIcon(root)).rejects.toThrow("ENOENT");
  expect(runIconsTool).not.toHaveBeenCalled();
  expect(convertIcon).not.toHaveBeenCalled();
});