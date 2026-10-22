# Нативные тесты логики прошивки без PlatformIO: CMake + g++/clang.
# Те же исходники собирает `pio test -e native` (test/native/test_logic, doctest из реестра).
#
#   cmake -S firmware/test/native -B build/fw-native && cmake --build build/fw-native -j && ctest --test-dir build/fw-native --output-on-failure
#   -DBL_SANITIZE=ON — с AddressSanitizer и UndefinedBehaviorSanitizer
cmake_minimum_required(VERSION 3.16)
project(billiardum_firmware_native CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(BL_SANITIZE "AddressSanitizer + UBSan" OFF)
option(BL_WERROR "Предупреждения — ошибки" ON)

get_filename_component(FW_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
get_filename_component(REPO_ROOT "${FW_DIR}/.." ABSOLUTE)

file(GLOB LOGIC_SOURCES CONFIGURE_DEPENDS "${FW_DIR}/lib/logic/src/*.cpp")
file(GLOB TEST_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/test_logic/*.cpp")

set(BL_WARNINGS -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion)
if(BL_WERROR)
  list(APPEND BL_WARNINGS -Werror)
endif()

add_library(bl_logic STATIC ${LOGIC_SOURCES})
target_include_directories(bl_logic PUBLIC "${FW_DIR}/lib/logic/src")
target_compile_options(bl_logic PRIVATE ${BL_WARNINGS} -fno-exceptions -fno-rtti)

add_executable(bl_native_tests ${TEST_SOURCES})
target_include_directories(bl_native_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/test_logic" "${FW_DIR}/test/vendor/doctest")
target_link_libraries(bl_native_tests PRIVATE bl_logic)
target_compile_definitions(bl_native_tests PRIVATE BL_REPO_ROOT="${REPO_ROOT}")
target_compile_options(bl_native_tests PRIVATE -Wall -Wextra)

if(BL_SANITIZE)
  foreach(t bl_logic bl_native_tests)
    target_compile_options(${t} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer -g)
    target_link_options(${t} PRIVATE -fsanitize=address,undefined)
  endforeach()
endif()

enable_testing()
add_test(NAME firmware_logic COMMAND bl_native_tests)
