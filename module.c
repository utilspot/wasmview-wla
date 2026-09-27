#include "config.h"

#include <libnetq/Library.h>
#include <libnetq/fs/Path.h>
#include <libnetq/ErrorCode.h>
#include <libnetq/Malloc.h>
#include <libnetq/ByteBuffer.h>
#include <libnetq/Leb128.h>
#include <libnetq/io/DataReader.h>
#include <libnetq/http/HttpHeader.h>
#include <libnetq/http/HttpStatus.h>
#include <libnetq/http/MediaType.h>
#include <libnetq/Module.h>
#include <libnetq/json/JSONWriter.h>
#include <libnetq/web/WebServer.h>
#include <libnetq/web/WebManifest.h>
#include <libnetq/web/WebRequest.h>
#include <libnetq/web/WebResponse.h>
#include <libnetq/Assert.h>
#include <libnetq/string/Sprintf.h>

#include <libnetq/wasm/Module.h>

#define WASMVIEW_UPLOAD_MAX (64u * 1024u * 1024u)

typedef struct WebWasmviewExecutor WebWasmviewExecutor;
struct WebWasmviewExecutor {
  NQWebExecutor executor;
  NQWebManifestListeners manifestListeners;
  struct NQWebRequestListener moduleListener;
};

typedef struct ModuleRequest ModuleRequest;
struct ModuleRequest {
  NQByteBuffer data;
  bool tooLarge;
  bool noMemory;
};

static bool responseWriteJson(void* userdata, const char* characters, size_t size)
{
  NQWebResponse* response = (NQWebResponse*)userdata;
  int n = NQWebResponse_write(response, characters, size);
  return n < 0 ? false : true;
}

static int writeByteBuffer(void* userdata, const void* data, size_t size)
{
  NQByteBuffer* buffer = (NQByteBuffer*)userdata;
  return NQByteBuffer_append(buffer, (const uint8_t*)data, size) ? (int)size : -1;
}

static int responseError(NQWebResponse* response, int statusCode, const char* message)
{
  NQWebResponse_setHeader(response, NQHTTP_HEADER_CONTENT_TYPE, NQ_MEDIATYPE_APPLICATION_JSON);

  NQJSONWriter writer;
  NQJSONWriter_init(&writer, responseWriteJson, response);
  NQJSONWriter_writeObjectBegin(&writer);
  NQJSONWriter_writeKeyString(&writer, "error", message);
  NQJSONWriter_writeObjectEnd(&writer);
  NQJSONWriter_finalize(&writer);
  return statusCode;
}

// libnetq keeps only the import section decoded; every other section is
// available as its serialized form: id byte, LEB128 size, payload.
static bool sectionPayload(NQWasmSection* section, NQByteBuffer* buffer, NQDataReader* payload)
{
  NQByteBuffer_resize(buffer, 0);
  if (!NQWasmSection_writeTo(section, writeByteBuffer, buffer))
    return false;

  const uint8_t* data = NQByteBuffer_data(buffer);
  size_t size = NQByteBuffer_size(buffer);
  if (size < 1)
    return false;

  uint32_t payloadSize;
  size_t n = NQLeb128DecodeUint32(data + 1, size - 1, &payloadSize);
  if (n == 0 || 1 + n + payloadSize != size)
    return false;

  NQDataReader_init(payload, data + 1 + n, payloadSize);
  return true;
}

static bool readUint32(NQDataReader* reader, uint32_t* value)
{
  size_t n = NQLeb128DecodeUint32(NQDataReader_currentData(reader), NQDataReader_availableSize(reader), value);
  return n != 0 && NQDataReader_skipAll(reader, n);
}

static bool readUint64(NQDataReader* reader, uint64_t* value)
{
  size_t n = NQLeb128DecodeUint64(NQDataReader_currentData(reader), NQDataReader_availableSize(reader), value);
  return n != 0 && NQDataReader_skipAll(reader, n);
}

static bool readInt64(NQDataReader* reader, int64_t* value)
{
  size_t n = NQLeb128DecodeInt64(NQDataReader_currentData(reader), NQDataReader_availableSize(reader), value);
  return n != 0 && NQDataReader_skipAll(reader, n);
}

static bool readName(NQDataReader* reader, const char** characters, uint32_t* length)
{
  if (!readUint32(reader, length))
    return false;
  *characters = (const char*)NQDataReader_currentData(reader);
  return NQDataReader_skipAll(reader, *length);
}

static const char* heapTypeName(uint8_t code)
{
  switch (code) {
  case 0x70: return "func";
  case 0x6f: return "extern";
  case 0x6e: return "any";
  case 0x6d: return "eq";
  case 0x6c: return "i31";
  case 0x6b: return "struct";
  case 0x6a: return "array";
  case 0x69: return "exn";
  case 0x71: return "none";
  case 0x72: return "noextern";
  case 0x73: return "nofunc";
  case 0x74: return "noexn";
  }
  return NULL;
}

static const char* valTypeName(uint8_t code)
{
  switch (code) {
  case NQ_WASM_TYPE_I32: return "i32";
  case NQ_WASM_TYPE_I64: return "i64";
  case NQ_WASM_TYPE_F32: return "f32";
  case NQ_WASM_TYPE_F64: return "f64";
  case NQ_WASM_TYPE_V128: return "v128";
  case 0x70: return "funcref";
  case 0x6f: return "externref";
  case 0x6e: return "anyref";
  case 0x6d: return "eqref";
  case 0x6c: return "i31ref";
  case 0x6b: return "structref";
  case 0x6a: return "arrayref";
  case 0x69: return "exnref";
  case 0x71: return "nullref";
  case 0x72: return "nullexternref";
  case 0x73: return "nullfuncref";
  case 0x74: return "nullexnref";
  }
  return NULL;
}

static const char* valTypeLabel(uint8_t code)
{
  const char* name = valTypeName(code);
  return name ? name : "unknown";
}

static bool writeValType(NQJSONWriter* writer, NQDataReader* reader)
{
  uint8_t code;
  if (!NQDataReader_readUint8(reader, &code))
    return false;

  const char* name = valTypeName(code);
  if (name != NULL)
    return NQJSONWriter_writeString(writer, name);

  if (code != NQ_WASM_TYPE_REF && code != NQ_WASM_TYPE_REFNULL)
    return false;

  int64_t heapType;
  if (!readInt64(reader, &heapType))
    return false;

  char text[64];
  const char* prefix = code == NQ_WASM_TYPE_REFNULL ? "ref null" : "ref";
  if (heapType >= 0) {
    NQSnprintf(text, sizeof(text), "(%s %lld)", prefix, (long long)heapType);
  }
  else {
    const char* heapName = heapTypeName((uint8_t)(heapType & 0x7f));
    if (heapName == NULL)
      return false;
    NQSnprintf(text, sizeof(text), "(%s %s)", prefix, heapName);
  }
  return NQJSONWriter_writeString(writer, text);
}

static bool writeValTypeVector(NQJSONWriter* writer, const char* key, NQDataReader* reader)
{
  uint32_t count;
  if (!readUint32(reader, &count))
    return false;

  NQJSONWriter_writeKeyArrayBegin(writer, key);
  bool ok = true;
  for (uint32_t index = 0; ok && index < count; index++)
    ok = writeValType(writer, reader);
  NQJSONWriter_writeArrayEnd(writer);
  return ok;
}

// libnetq does not keep file positions, so section offsets come from walking
// the section headers of the uploaded bytes next to the parsed section list.
static bool readSectionHeader(NQDataReader* reader, const NQWasmSection* section, size_t* offset, uint32_t* size)
{
  uint8_t sectionId;
  if (!NQDataReader_readUint8(reader, &sectionId) || sectionId != section->sectionId || !readUint32(reader, size))
    return false;
  *offset = NQDataReader_position(reader);
  return NQDataReader_skipAll(reader, *size);
}

static bool sectionsMatch(const NQWasmModule* module, const NQByteBuffer* data)
{
  NQDataReader reader;
  NQDataReader_init(&reader, NQByteBuffer_data(data), NQByteBuffer_size(data));
  if (!NQDataReader_skipAll(&reader, NQ_WASM_MAG_LEN + sizeof(uint32_t)))
    return false;

  for (NQWasmSection* section = NQWasmModule_firstSection(module); section != NULL; section = NQWasmModule_nextSection(module, section)) {
    size_t offset;
    uint32_t size;
    if (!readSectionHeader(&reader, section, &offset, &size))
      return false;
  }
  return NQDataReader_isEmpty(&reader);
}

// Only the payload position is sent; the client reads the bytes from its copy
// of the file.
static void writeSection(NQJSONWriter* writer, const NQWasmSection* section, const uint8_t* data, size_t offset, uint32_t size)
{
  NQJSONWriter_writeObjectBegin(writer);
  NQJSONWriter_writeKeyUint8(writer, "id", section->sectionId);
  NQJSONWriter_writeKeyString(writer, "name", NQGetWasmSectionNameById(section->sectionId));
  NQJSONWriter_writeKeyUint64(writer, "offset", offset);
  NQJSONWriter_writeKeyUint32(writer, "size", size);

  NQDataReader payload;
  NQDataReader_init(&payload, data + offset, size);

  uint32_t value;
  const char* name;
  switch (section->sectionId) {
  case NQ_WASM_SECTION_CUSTOM_ID:
    if (readName(&payload, &name, &value))
      NQJSONWriter_writeKeyString2(writer, "customName", name, value);
    break;

  case NQ_WASM_SECTION_START_ID:
    break;

  default:
    // All remaining known sections begin with a vector length or, for
    // DataCount, with the count itself.
    if (section->sectionId <= NQ_WASM_SECTION_DATA_COUNT_ID && readUint32(&payload, &value))
      NQJSONWriter_writeKeyUint32(writer, "count", value);
    break;
  }

  NQJSONWriter_writeObjectEnd(writer);
}

static void writeImports(NQJSONWriter* writer, const NQWasmModule* module)
{
  NQJSONWriter_writeKeyArrayBegin(writer, "imports");

  NQWasmImportSection* imports = NQWasmModule_findImportSection(module);
  NQWasmImportItem* item = imports ? NQWasmImportSection_firstItem(imports) : NULL;
  while (item != NULL) {
    NQJSONWriter_writeObjectBegin(writer);
    NQJSONWriter_writeKeyString(writer, "module", item->module);
    NQJSONWriter_writeKeyString(writer, "name", item->name);

    switch (item->importId) {
    case NQ_WASM_IMPORT_FUNC_ID:
      NQJSONWriter_writeKeyString(writer, "kind", "function");
      NQJSONWriter_writeKeyUint32(writer, "type", item->function.typeidx);
      break;

    case NQ_WASM_IMPORT_TABLE_ID:
      NQJSONWriter_writeKeyString(writer, "kind", "table");
      NQJSONWriter_writeKeyString(writer, "elemType", valTypeLabel(item->table.elemtype));
      NQJSONWriter_writeKeyUint32(writer, "min", item->table.minValue);
      NQJSONWriter_writeKeyUint32(writer, "max", item->table.maxValue);
      break;

    case NQ_WASM_IMPORT_MEM_ID:
      NQJSONWriter_writeKeyString(writer, "kind", "memory");
      NQJSONWriter_writeKeyUint64(writer, "min", item->memory.minValue);
      if (item->memory.memtype & NQ_WASM_MEMTYPE_MAXVAL)
        NQJSONWriter_writeKeyUint64(writer, "max", item->memory.maxValue);
      NQJSONWriter_writeKeyBool(writer, "shared", (item->memory.memtype & NQ_WASM_MEMTYPE_SHARED) != 0);
      NQJSONWriter_writeKeyBool(writer, "memory64", (item->memory.memtype & NQ_WASM_MEMTYPE_WASM64) != 0);
      break;

    case NQ_WASM_IMPORT_GLOBAL_ID:
      NQJSONWriter_writeKeyString(writer, "kind", "global");
      NQJSONWriter_writeKeyString(writer, "valType", valTypeLabel(item->global.valtype));
      NQJSONWriter_writeKeyBool(writer, "mutable", item->global.mut != 0);
      break;
    }

    NQJSONWriter_writeObjectEnd(writer);
    item = NQWasmImportSection_nextItem(imports, item);
  }

  NQJSONWriter_writeArrayEnd(writer);
}

static void writeTypes(NQJSONWriter* writer, const NQWasmModule* module, NQByteBuffer* buffer)
{
  bool complete = true;
  NQJSONWriter_writeKeyArrayBegin(writer, "types");

  NQWasmSection* section = NQWasmModule_findSection(module, NQ_WASM_SECTION_TYPE_ID);
  NQDataReader payload;
  uint32_t count;
  if (section != NULL && sectionPayload(section, buffer, &payload) && readUint32(&payload, &count)) {
    for (uint32_t index = 0; index < count; index++) {
      uint8_t form;
      // Only plain function types are decoded; GC composite and recursive types stop the listing.
      if (!NQDataReader_readUint8(&payload, &form) || form != 0x60) {
        complete = false;
        break;
      }

      NQJSONWriter_writeObjectBegin(writer);
      bool ok = writeValTypeVector(writer, "params", &payload) && writeValTypeVector(writer, "results", &payload);
      NQJSONWriter_writeObjectEnd(writer);
      if (!ok) {
        complete = false;
        break;
      }
    }
  }

  NQJSONWriter_writeArrayEnd(writer);
  NQJSONWriter_writeKeyBool(writer, "typesComplete", complete);
}

static void writeFunctions(NQJSONWriter* writer, const NQWasmModule* module, NQByteBuffer* buffer)
{
  NQJSONWriter_writeKeyArrayBegin(writer, "functions");

  NQWasmSection* section = NQWasmModule_findSection(module, NQ_WASM_SECTION_FUNCTION_ID);
  NQDataReader payload;
  uint32_t count;
  if (section != NULL && sectionPayload(section, buffer, &payload) && readUint32(&payload, &count)) {
    uint32_t typeidx;
    for (uint32_t index = 0; index < count && readUint32(&payload, &typeidx); index++)
      NQJSONWriter_writeUint32(writer, typeidx);
  }

  NQJSONWriter_writeArrayEnd(writer);
}

static void writeMemories(NQJSONWriter* writer, const NQWasmModule* module, NQByteBuffer* buffer)
{
  NQJSONWriter_writeKeyArrayBegin(writer, "memories");

  NQWasmSection* section = NQWasmModule_findSection(module, NQ_WASM_SECTION_MEMORY_ID);
  NQDataReader payload;
  uint32_t count;
  if (section != NULL && sectionPayload(section, buffer, &payload) && readUint32(&payload, &count)) {
    for (uint32_t index = 0; index < count; index++) {
      uint8_t memtype;
      uint64_t minValue;
      uint64_t maxValue = 0;
      if (!NQDataReader_readUint8(&payload, &memtype) || !NQWasmIsMemType(memtype) || !readUint64(&payload, &minValue))
        break;
      if ((memtype & NQ_WASM_MEMTYPE_MAXVAL) && !readUint64(&payload, &maxValue))
        break;

      NQJSONWriter_writeObjectBegin(writer);
      NQJSONWriter_writeKeyUint64(writer, "min", minValue);
      if (memtype & NQ_WASM_MEMTYPE_MAXVAL)
        NQJSONWriter_writeKeyUint64(writer, "max", maxValue);
      NQJSONWriter_writeKeyBool(writer, "shared", (memtype & NQ_WASM_MEMTYPE_SHARED) != 0);
      NQJSONWriter_writeKeyBool(writer, "memory64", (memtype & NQ_WASM_MEMTYPE_WASM64) != 0);
      NQJSONWriter_writeObjectEnd(writer);
    }
  }

  NQJSONWriter_writeArrayEnd(writer);
}

static const char* exportKindName(uint8_t kind)
{
  switch (kind) {
  case 0: return "function";
  case 1: return "table";
  case 2: return "memory";
  case 3: return "global";
  case 4: return "tag";
  }
  return NULL;
}

static void writeExports(NQJSONWriter* writer, const NQWasmModule* module, NQByteBuffer* buffer)
{
  NQJSONWriter_writeKeyArrayBegin(writer, "exports");

  NQWasmSection* section = NQWasmModule_findSection(module, NQ_WASM_SECTION_EXPORT_ID);
  NQDataReader payload;
  uint32_t count;
  if (section != NULL && sectionPayload(section, buffer, &payload) && readUint32(&payload, &count)) {
    for (uint32_t index = 0; index < count; index++) {
      const char* name;
      uint32_t length;
      uint8_t kind;
      uint32_t itemIndex;
      if (!readName(&payload, &name, &length) || !NQDataReader_readUint8(&payload, &kind) || !readUint32(&payload, &itemIndex))
        break;

      const char* kindName = exportKindName(kind);
      if (kindName == NULL)
        break;

      NQJSONWriter_writeObjectBegin(writer);
      NQJSONWriter_writeKeyString2(writer, "name", name, length);
      NQJSONWriter_writeKeyString(writer, "kind", kindName);
      NQJSONWriter_writeKeyUint32(writer, "index", itemIndex);
      NQJSONWriter_writeObjectEnd(writer);
    }
  }

  NQJSONWriter_writeArrayEnd(writer);
}

static void writeStart(NQJSONWriter* writer, const NQWasmModule* module, NQByteBuffer* buffer)
{
  NQWasmSection* section = NQWasmModule_findSection(module, NQ_WASM_SECTION_START_ID);
  NQDataReader payload;
  uint32_t funcidx;
  if (section != NULL && sectionPayload(section, buffer, &payload) && readUint32(&payload, &funcidx))
    NQJSONWriter_writeKeyUint32(writer, "start", funcidx);
}

static int responseModule(NQWebResponse* response, const NQByteBuffer* data)
{
  NQWasmModule* module = NQWasmModule_fromMemory(NQByteBuffer_data(data), NQByteBuffer_size(data));
  if (module == NULL)
    return responseError(response, NQ_HTTP_BAD_REQUEST, "The file is not a valid WebAssembly module");

  if (!sectionsMatch(module, data)) {
    NQWasmModule_destroy(module);
    return responseError(response, NQ_HTTP_INTERNAL_SERVER_ERROR, "Section layout does not match the parsed module");
  }

  NQWebResponse_setHeader(response, NQHTTP_HEADER_CONTENT_TYPE, NQ_MEDIATYPE_APPLICATION_JSON);

  NQByteBuffer buffer;
  NQByteBuffer_init(&buffer);

  NQJSONWriter writer;
  NQJSONWriter_init(&writer, responseWriteJson, response);

  NQJSONWriter_writeObjectBegin(&writer);
  NQJSONWriter_writeKeyUint64(&writer, "size", NQByteBuffer_size(data));
  NQJSONWriter_writeKeyUint32(&writer, "version", module->header.version);

  NQDataReader reader;
  NQDataReader_init(&reader, NQByteBuffer_data(data), NQByteBuffer_size(data));
  NQDataReader_skipAll(&reader, NQ_WASM_MAG_LEN + sizeof(uint32_t));

  NQJSONWriter_writeKeyArrayBegin(&writer, "sections");
  NQWasmSection* section = NQWasmModule_firstSection(module);
  while (section != NULL) {
    size_t offset;
    uint32_t size;
    readSectionHeader(&reader, section, &offset, &size);
    writeSection(&writer, section, NQByteBuffer_data(data), offset, size);
    section = NQWasmModule_nextSection(module, section);
  }
  NQJSONWriter_writeArrayEnd(&writer);

  writeTypes(&writer, module, &buffer);
  writeImports(&writer, module);
  writeFunctions(&writer, module, &buffer);
  writeMemories(&writer, module, &buffer);
  writeExports(&writer, module, &buffer);
  writeStart(&writer, module, &buffer);

  NQJSONWriter_writeObjectEnd(&writer);
  NQJSONWriter_finalize(&writer);

  NQByteBuffer_finalize(&buffer);
  NQWasmModule_destroy(module);
  return NQ_HTTP_OK;
}

static void moduleRequestDestroy(ModuleRequest* ctx)
{
  NQByteBuffer_finalize(&ctx->data);
  NQFree(ctx);
}

static int moduleInit(NQWebRequest* request, void* data)
{
  NQ_UNUSED_PARAM(data);

  ModuleRequest* ctx = (ModuleRequest*)NQZalloc(sizeof(ModuleRequest));
  if (ctx == NULL)
    return -NQ_ENOMEM;

  NQByteBuffer_init(&ctx->data);
  request->userdata = ctx;
  return 0;
}

static size_t moduleReceive(NQWebRequest* request, const char* data, size_t size)
{
  ModuleRequest* ctx = (ModuleRequest*)request->userdata;
  if (ctx->tooLarge || ctx->noMemory)
    return size;

  if (NQByteBuffer_size(&ctx->data) + size > WASMVIEW_UPLOAD_MAX) {
    ctx->tooLarge = true;
    NQByteBuffer_clear(&ctx->data);
    return size;
  }

  if (!NQByteBuffer_append(&ctx->data, (const uint8_t*)data, size)) {
    ctx->noMemory = true;
    NQByteBuffer_clear(&ctx->data);
  }
  return size;
}

static int moduleHandler(NQWebRequest* request, NQWebResponse* response)
{
  ModuleRequest* ctx = (ModuleRequest*)request->userdata;

  int statusCode;
  if (ctx->tooLarge)
    statusCode = responseError(response, NQ_HTTP_REQUEST_ENTITY_TOO_LARGE, "The file is too large");
  else if (ctx->noMemory)
    statusCode = responseError(response, NQ_HTTP_INTERNAL_SERVER_ERROR, "Not enough memory");
  else if (NQByteBuffer_isEmpty(&ctx->data))
    statusCode = responseError(response, NQ_HTTP_BAD_REQUEST, "The request body is empty");
  else
    statusCode = responseModule(response, &ctx->data);

  // Not every server backend invokes release, so free the upload here.
  request->userdata = NULL;
  moduleRequestDestroy(ctx);
  return statusCode;
}

static void moduleRelease(NQWebRequest* request)
{
  ModuleRequest* ctx = (ModuleRequest*)request->userdata;
  if (ctx != NULL) {
    request->userdata = NULL;
    moduleRequestDestroy(ctx);
  }
}

static const NQWebRequestOperations kModuleOps = {
  .init = moduleInit,
  .receive = moduleReceive,
  .handler = moduleHandler,
  .release = moduleRelease,
};

static int executorInit(NQWebExecutor* executor, void* data)
{
  NQ_UNUSED_PARAM(data);

  struct WebWasmviewExecutor* wasmview = (struct WebWasmviewExecutor*)executor;

  NQLibraryInfo info;
  int ret = NQLibraryInfoLoad(&info, &executorInit);
  if (ret != 0)
    return ret;

  NQPath* manifest = NQPath_join3(info.filename, "../../" WASMVIEW_ASSETS_DIR, NQ_WEBMANIFEST_FILE);
  NQLibraryInfoFinalize(&info);
  if (manifest == NULL) {
    return -NQ_ENOMEM;
  }

  ret = NQWebManifestListenersInit(executor, &wasmview->manifestListeners, NQPath_characters(manifest));
  NQPath_destroy(manifest);
  if (ret != 0) {
    return ret;
  }

  ret = NQWebExecutor_addRequestListener(&wasmview->executor, &wasmview->moduleListener, &kModuleOps, wasmview, NQ_HTTP_POST, "%s", WASMVIEW_SERVICE_URL);
  if (ret != 0) {
    NQWebManifestListenersFinalize(&wasmview->executor, &wasmview->manifestListeners);
    return ret;
  }

  return ret;
}

static void executorRelease(NQWebExecutor* executor)
{
  struct WebWasmviewExecutor* wasmview = (struct WebWasmviewExecutor*)executor;
  NQWebExecutor_removeRequestListener(&wasmview->executor, &wasmview->moduleListener);
  NQWebManifestListenersFinalize(&wasmview->executor, &wasmview->manifestListeners);
}

static struct NQWebExecutorOperations s_executorOps = {
  .name = "wasmview",
  .init = executorInit,
  .release = executorRelease,
  .size = sizeof(struct WebWasmviewExecutor),
};

static int moduleLoad(NQContext* context)
{
  NQWebExecutorRegister(&s_executorOps);
  return 0;
}

static void moduleUnload(NQContext* context)
{
  NQWebExecutorUnregister(&s_executorOps);
}

NQ_MODULE_INIT(moduleLoad);
NQ_MODULE_EXIT(moduleUnload);
