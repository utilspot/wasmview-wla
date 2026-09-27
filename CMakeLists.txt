cmake_minimum_required(VERSION 3.8)
project(wasmview-wla VERSION 1.0.0 LANGUAGES C)

include(GNUInstallDirs)

find_program(NPM_EXECUTABLE npm REQUIRED)
mark_as_advanced(NPM_EXECUTABLE)

if (WIN32)
  set(NPM_PREFIX "cmd" "/c")
endif ()

find_package(LibNetQ REQUIRED)

option(WASMVIEW_INSTALL_SERVER "Install the wasmview server" ON)
option(WASMVIEW_INSTALL_MODULE "Install the wasmview module" ON)
option(WASMVIEW_INSTALL_ASSETS "Install wasmview supporting assets" ON)

set(WASMVIEW_BASE_URL "/" CACHE STRING "URL path prefix the wasmview module is served under (a trailing slash is appended if missing)")
set(WASMVIEW_ROOT_URL "${WASMVIEW_BASE_URL}")
if(NOT WASMVIEW_ROOT_URL MATCHES "/$")
  set(WASMVIEW_ROOT_URL "${WASMVIEW_ROOT_URL}/")
endif()

set(WASMVIEW_SERVICE_URL "${WASMVIEW_ROOT_URL}modinfo")
set(WASMVIEW_ASSETS_DIR "${CMAKE_INSTALL_DATADIR}/${PROJECT_NAME}")

set(WASMVIEW_DATAFILES
  config.h.in
  )

file(GLOB_RECURSE WASMVIEW_UIFILES
  "src/*.ts"
  "src/*.tsx"
  "src/*.css"
  "src/*.html"
  "src/*.svg"
  )

set(WASMVIEW_DISTFILES
  dist/index.html
  dist/index.js
  dist/index.css
  dist/favicon.svg
  dist/manifest.json
  )

add_custom_command(
  COMMAND ${NPM_PREFIX} "${NPM_EXECUTABLE}" install
  COMMAND ${NPM_PREFIX} "${NPM_EXECUTABLE}" run build --base-url=${WASMVIEW_BASE_URL}
  DEPENDS package.json vite.config.ts ${WASMVIEW_UIFILES}
  OUTPUT ${WASMVIEW_DISTFILES}
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
  )

configure_file(config.h.in "${CMAKE_CURRENT_BINARY_DIR}/config.h" @ONLY)

source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES module.c ${WASMVIEW_DATAFILES} ${WASMVIEW_DISTFILES})
add_library(wasmview_wla SHARED module.c ${WASMVIEW_DATAFILES} ${WASMVIEW_DISTFILES})
target_include_directories(wasmview_wla PRIVATE "$<BUILD_INTERFACE:${CMAKE_CURRENT_BINARY_DIR}>")
target_link_libraries(wasmview_wla PUBLIC LibNetQ::LibNetQ)
set_property(TARGET wasmview_wla PROPERTY POSITION_INDEPENDENT_CODE ON)
set_target_properties(wasmview_wla PROPERTIES PREFIX "" IMPORT_PREFIX "")

source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES server.c)
add_executable(wasmview_server server.c)
target_link_libraries(wasmview_server PRIVATE LibNetQ::LibNetQ)

if (APPLE)
  set_target_properties(wasmview_server PROPERTIES INSTALL_RPATH "@loader_path/../lib")
elseif (UNIX)
  set_target_properties(wasmview_server PROPERTIES INSTALL_RPATH "$ORIGIN/../lib")
endif ()

if (WASMVIEW_INSTALL_SERVER)
  install(TARGETS wasmview_server
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    )
endif ()

if (WASMVIEW_INSTALL_MODULE)
  install(TARGETS wasmview_wla
    LIBRARY DESTINATION ${CMAKE_INSTALL_BINDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    )
endif ()

if (WASMVIEW_INSTALL_ASSETS)
  install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/dist/"
    DESTINATION "${WASMVIEW_ASSETS_DIR}"
    )
endif ()
