#define NQ_LOG_TAG "opcodes"

#include <libnetq/Log.h>
#include <libnetq/ByteBuffer.h>
#include <libnetq/fs/FileSystem.h>
#include <libnetq/json/JSONWriter.h>

struct OpcodeStruct {
  const char* name;
  const char* wat;
  uint32_t code;
};

#define NQ_WASM_OPCODE(name, wat, opcode) { NQ_STRINGIZE(name), wat, opcode },
static const struct OpcodeStruct s_opcodes[] =
{
  #include <libnetq/wasm/Opcodes.def>
};
#undef NQ_WASM_OPCODE

// This runs as a build step, so errors are logged in release builds too.
static bool jsonWriterHandler(void* userdata, const char* characters, size_t size)
{
  NQByteBuffer* buffer = (NQByteBuffer*)userdata;
  if (!NQByteBuffer_append(buffer, (const uint8_t*)characters, size)) {
    NQ_LOGE("not enough memory to grow the JSON buffer by %llu bytes", (unsigned long long)size);
    return false;
  }
  return true;
}

static bool buildJSON(NQJSONWriter* writer)
{
  NQJSONWriter_writeArrayBegin(writer);
  for (size_t i = 0; i < NQ_ARRAY_LENGTH(s_opcodes); i++) {
    const struct OpcodeStruct* iter = &s_opcodes[i];
    NQJSONWriter_writeObjectBegin(writer);
    NQJSONWriter_writeKeyString(writer, "name", iter->name);
    NQJSONWriter_writeKeyString(writer, "wat", iter->wat);
    NQJSONWriter_writeKeyUint32(writer, "code", iter->code);
    NQJSONWriter_writeObjectEnd(writer);

    // The writer stops writing after the first failure, so report where it happened.
    if (writer->hasError) {
      NQ_LOGE("failed to serialise opcode %s (0x%x)", iter->name, (unsigned)iter->code);
      return false;
    }
  }
  NQJSONWriter_writeArrayEnd(writer);

  if (writer->hasError) {
    NQ_LOGE("failed to serialise the opcode list");
    return false;
  }
  return true;
}

int main(int argc, const char* argv[])
{
  if (argc != 2 || argv[1][0] == '\0') {
    NQ_LOGE("usage: %s <output.json>", argc > 0 ? argv[0] : "opcodes");
    return NQ_EXIT_FAILURE;
  }
  const char* outputPath = argv[1];

  NQByteBuffer buffer;
  NQByteBuffer_init(&buffer);

  NQJSONWriter writer;
  NQJSONWriter_init(&writer, &jsonWriterHandler, &buffer);
  // NQJSONWriter_finalize asserts on a failed writer, so it runs only on success.
  if (!buildJSON(&writer)) {
    NQByteBuffer_finalize(&buffer);
    return NQ_EXIT_FAILURE;
  }
  NQJSONWriter_finalize(&writer);

  int64_t size = (int64_t)NQByteBuffer_size(&buffer);
  int64_t written = NQWriteFile(outputPath, NQByteBuffer_data(&buffer), size);
  NQByteBuffer_finalize(&buffer);
  if (written != size) {
    NQ_LOGE("failed to write %s (%lld of %lld bytes written)", outputPath, (long long)written, (long long)size);
    return NQ_EXIT_FAILURE;
  }

  return NQ_EXIT_SUCCESS;
}
