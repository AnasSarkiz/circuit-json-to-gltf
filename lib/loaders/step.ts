import type {
  AuthHeaders,
  CoordinateTransformConfig,
  OBJMaterial,
  OBJMesh,
  Point3,
  STLMesh,
  Triangle,
} from "../types"
import {
  COORDINATE_TRANSFORMS,
  transformTriangles,
} from "../utils/coordinate-transform"
import { resolveModelUrl } from "./resolve-model-url"

const stepCache = new Map<string, STLMesh | OBJMesh>()
const occtModulePromiseByKey = new Map<string, Promise<any>>()
const OCCT_WASM_MODULE_PATH =
  "node_modules/occt-import-js/dist/occt-import-js.wasm"
const OCCT_WASM_CDN_URLS = [
  "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/occt-import-js.wasm",
  "https://unpkg.com/occt-import-js@0.0.23/dist/occt-import-js.wasm",
]
const WASM_MAGIC_WORD = [0x00, 0x61, 0x73, 0x6d] as const
const isNodeRuntime =
  typeof process !== "undefined" && Boolean(process.versions?.node)
type WasmCandidate = {
  url: string
  label: string
  useAuthHeaders: boolean
}

function getBrowserOrigin(): string | undefined {
  if (typeof location === "undefined" || !location.origin) {
    return undefined
  }
  return location.origin
}

function isValidWasmBinary(bytes: Uint8Array): boolean {
  if (bytes.length < WASM_MAGIC_WORD.length) {
    return false
  }

  return WASM_MAGIC_WORD.every((value, index) => bytes[index] === value)
}

function getAuthHeadersCacheKey(authHeaders?: AuthHeaders): string {
  if (!authHeaders) return ""

  return Object.entries(authHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|")
}

async function fetchWasmBinary(
  url: string,
  headers?: AuthHeaders,
): Promise<Uint8Array> {
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!isValidWasmBinary(bytes)) {
    throw new Error("Response was not a valid WebAssembly binary")
  }

  return bytes
}

async function getBrowserWasmCandidates(
  projectBaseUrl?: string,
): Promise<WasmCandidate[]> {
  const candidates: WasmCandidate[] = []
  const seenUrls = new Set<string>()
  const browserOrigin = getBrowserOrigin()

  const addCandidate = (
    url: string,
    label: string,
    useAuthHeaders: boolean,
  ): void => {
    if (seenUrls.has(url)) return
    seenUrls.add(url)
    candidates.push({ url, label, useAuthHeaders })
  }

  if (projectBaseUrl) {
    try {
      const wasmUrl = await resolveModelUrl(
        OCCT_WASM_MODULE_PATH,
        projectBaseUrl,
      )
      addCandidate(wasmUrl, `resolved from ${projectBaseUrl}`, true)
    } catch {
      // continue to the next candidate strategy
    }
  }

  if (browserOrigin) {
    addCandidate(
      new URL(
        "/node_modules/occt-import-js/dist/occt-import-js.wasm",
        browserOrigin,
      ).toString(),
      "browser origin /node_modules path",
      false,
    )
  }

  for (const cdnUrl of OCCT_WASM_CDN_URLS) {
    addCandidate(cdnUrl, "CDN fallback", false)
  }

  return candidates
}

async function initializeOcctModuleForBrowser({
  occtimportjs,
  projectBaseUrl,
  authHeaders,
}: {
  occtimportjs: any
  projectBaseUrl?: string
  authHeaders?: AuthHeaders
}): Promise<any> {
  const errors: string[] = []
  const wasmCandidates = await getBrowserWasmCandidates(projectBaseUrl)

  for (const candidate of wasmCandidates) {
    try {
      const wasmBinary = await fetchWasmBinary(
        candidate.url,
        candidate.useAuthHeaders ? authHeaders : undefined,
      )
      return await occtimportjs({ wasmBinary })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${candidate.label} (${candidate.url}) failed: ${message}`)
    }
  }

  throw new Error(
    `Failed to initialize occt-import-js wasm. ${errors.join(" | ")}`,
  )
}

async function getOcctModule({
  projectBaseUrl,
  authHeaders,
}: {
  projectBaseUrl?: string
  authHeaders?: AuthHeaders
}): Promise<any> {
  const browserOrigin = getBrowserOrigin()
  const cacheBase = projectBaseUrl ?? browserOrigin
  const moduleCacheKey = isNodeRuntime
    ? "node"
    : `${cacheBase ?? "no-project-base-url"}::${getAuthHeadersCacheKey(authHeaders)}`

  if (!occtModulePromiseByKey.has(moduleCacheKey)) {
    const modulePromise = (async () => {
      // @ts-ignore
      const occtimportjs = (await import("occt-import-js")).default
      return isNodeRuntime
        ? occtimportjs()
        : initializeOcctModuleForBrowser({
            occtimportjs,
            projectBaseUrl,
            authHeaders,
          })
    })()
    occtModulePromiseByKey.set(moduleCacheKey, modulePromise)
    modulePromise.catch(() => {
      occtModulePromiseByKey.delete(moduleCacheKey)
    })
  }
  return occtModulePromiseByKey.get(moduleCacheKey)!
}

export async function loadSTEP({
  url,
  transform,
  projectBaseUrl,
  authHeaders,
}: {
  url: string
  transform?: CoordinateTransformConfig
  projectBaseUrl?: string
  authHeaders?: AuthHeaders
}): Promise<STLMesh | OBJMesh> {
  const resolvedUrl = await resolveModelUrl(url, projectBaseUrl)
  const cacheKey = `${resolvedUrl}:${JSON.stringify(transform ?? {})}`
  if (stepCache.has(cacheKey)) {
    return stepCache.get(cacheKey)!
  }

  const response = await fetch(resolvedUrl, { headers: authHeaders })
  if (!response.ok) {
    throw new Error(
      `Failed to fetch STEP file: ${response.status} ${response.statusText}`,
    )
  }
  const buffer = await response.arrayBuffer()
  const fileBuffer = new Uint8Array(buffer)

  const occt = await getOcctModule({ projectBaseUrl, authHeaders })
  const result = occt.ReadStepFile(fileBuffer, {
    linearUnit: "millimeter",
  })

  if (!result.success) {
    throw new Error("Failed to parse STEP file")
  }

  const mesh = convertOcctResultToMesh(result, transform)
  stepCache.set(cacheKey, mesh)
  return mesh
}

function convertOcctResultToMesh(
  result: any,
  transform?: CoordinateTransformConfig,
): STLMesh | OBJMesh {
  const allTriangles: Triangle[] = []

  for (const mesh of result.meshes) {
    const positions = mesh.attributes.position.array
    const normals = mesh.attributes?.normal?.array
    const indices = mesh.index.array

    // Determine per-face color mapping from brep_faces
    const brepFaces: Array<{
      first: number
      last: number
      color: [number, number, number] | null
    }> = mesh.brep_faces ?? []

    // Mesh-level color (0-1 range from occt-import-js)
    const meshColor: [number, number, number] | undefined = mesh.color
      ? [mesh.color[0], mesh.color[1], mesh.color[2]]
      : undefined

    // Process triangles from indices (groups of 3)
    const numTriangles = indices.length / 3
    for (let t = 0; t < numTriangles; t++) {
      const i0 = indices[t * 3]!
      const i1 = indices[t * 3 + 1]!
      const i2 = indices[t * 3 + 2]!

      const v0: Point3 = {
        x: positions[i0 * 3]!,
        y: positions[i0 * 3 + 1]!,
        z: positions[i0 * 3 + 2]!,
      }
      const v1: Point3 = {
        x: positions[i1 * 3]!,
        y: positions[i1 * 3 + 1]!,
        z: positions[i1 * 3 + 2]!,
      }
      const v2: Point3 = {
        x: positions[i2 * 3]!,
        y: positions[i2 * 3 + 1]!,
        z: positions[i2 * 3 + 2]!,
      }

      let normal: Point3
      if (normals) {
        normal = {
          x: (normals[i0 * 3]! + normals[i1 * 3]! + normals[i2 * 3]!) / 3,
          y:
            (normals[i0 * 3 + 1]! +
              normals[i1 * 3 + 1]! +
              normals[i2 * 3 + 1]!) /
            3,
          z:
            (normals[i0 * 3 + 2]! +
              normals[i1 * 3 + 2]! +
              normals[i2 * 3 + 2]!) /
            3,
        }
      } else {
        normal = computeNormal(v0, v1, v2)
      }

      // Find the color for this triangle from brep_faces
      let triangleColor: [number, number, number, number] | undefined
      let foundFaceColor = false

      for (const face of brepFaces) {
        if (t >= face.first && t <= face.last && face.color) {
          triangleColor = [
            Math.round(face.color[0] * 255),
            Math.round(face.color[1] * 255),
            Math.round(face.color[2] * 255),
            1.0,
          ]
          foundFaceColor = true
          break
        }
      }

      // Fall back to mesh-level color if no face color found
      if (!foundFaceColor && meshColor) {
        triangleColor = [
          Math.round(meshColor[0] * 255),
          Math.round(meshColor[1] * 255),
          Math.round(meshColor[2] * 255),
          1.0,
        ]
      }

      allTriangles.push({
        vertices: [v0, v1, v2],
        normal,
        color: triangleColor,
      })
    }
  }

  // Apply coordinate transformation
  // STEP files use Z-up coordinate system, same as STL
  const finalConfig = transform ?? COORDINATE_TRANSFORMS.Z_UP_TO_Y_UP
  const transformedTriangles = transformTriangles(allTriangles, finalConfig)

  // Use OBJMesh path when colors are present, otherwise plain STLMesh
  const hasColors = transformedTriangles.some((t) => t.color !== undefined)

  if (hasColors) {
    return convertToOBJMesh(transformedTriangles)
  }

  return {
    triangles: transformedTriangles,
    boundingBox: calculateBoundingBox(transformedTriangles),
  }
}

function convertToOBJMesh(triangles: Triangle[]): OBJMesh {
  const colorGroups = new Map<string, Triangle[]>()

  for (const triangle of triangles) {
    const colorKey = triangle.color ? JSON.stringify(triangle.color) : "default"
    if (!colorGroups.has(colorKey)) {
      colorGroups.set(colorKey, [])
    }
    colorGroups.get(colorKey)!.push(triangle)
  }

  const materials = new Map<string, OBJMaterial>()
  const materialIndexMap = new Map<string, number>()
  let materialIndex = 0

  const trianglesWithMaterialIndex: Triangle[] = []

  for (const [colorKey, groupTriangles] of colorGroups) {
    const materialName = `Material_${materialIndex}`
    materialIndexMap.set(materialName, materialIndex)

    if (colorKey === "default") {
      materials.set(materialName, {
        name: materialName,
        color: [179, 179, 179, 1.0],
      })
    } else {
      const color = JSON.parse(colorKey)
      materials.set(materialName, {
        name: materialName,
        color,
      })
    }

    for (const triangle of groupTriangles) {
      trianglesWithMaterialIndex.push({
        ...triangle,
        materialIndex,
      })
    }

    materialIndex++
  }

  return {
    triangles: trianglesWithMaterialIndex,
    boundingBox: calculateBoundingBox(trianglesWithMaterialIndex),
    materials,
    materialIndexMap,
  }
}

function computeNormal(v0: Point3, v1: Point3, v2: Point3): Point3 {
  const edge1 = {
    x: v1.x - v0.x,
    y: v1.y - v0.y,
    z: v1.z - v0.z,
  }
  const edge2 = {
    x: v2.x - v0.x,
    y: v2.y - v0.y,
    z: v2.z - v0.z,
  }

  return {
    x: edge1.y * edge2.z - edge1.z * edge2.y,
    y: edge1.z * edge2.x - edge1.x * edge2.z,
    z: edge1.x * edge2.y - edge1.y * edge2.x,
  }
}

function calculateBoundingBox(triangles: Triangle[]): {
  min: Point3
  max: Point3
} {
  if (triangles.length === 0) {
    return {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 0, y: 0, z: 0 },
    }
  }

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity

  for (const triangle of triangles) {
    for (const vertex of triangle.vertices) {
      minX = Math.min(minX, vertex.x)
      minY = Math.min(minY, vertex.y)
      minZ = Math.min(minZ, vertex.z)
      maxX = Math.max(maxX, vertex.x)
      maxY = Math.max(maxY, vertex.y)
      maxZ = Math.max(maxZ, vertex.z)
    }
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  }
}

export function clearSTEPCache() {
  stepCache.clear()
}
