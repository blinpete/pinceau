import { existsSync } from 'fs'
import { join, resolve } from 'pathe'
import glob from 'fast-glob'
import { addPlugin, addPluginTemplate, addPrerenderRoutes, createResolver, defineNuxtModule, resolveAlias, resolveModule } from '@nuxt/kit'
import createJITI from 'jiti'
import type { PinceauOptions } from './types'
import pinceau, { defaultOptions } from './unplugin'
import { prepareOutputDir } from './theme/output'
import { useDebugPerformance } from './utils/debug'
import { walkTokens } from './utils'

const module: any = defineNuxtModule<PinceauOptions>({
  meta: {
    name: 'pinceau/nuxt',
    configKey: 'pinceau',
  },
  defaults: nuxt => ({
    ...defaultOptions,
    colorSchemeMode: 'class',
    outputDir: join(nuxt.options.buildDir, 'pinceau/'),
  }),
  async setup(options: PinceauOptions, nuxt) {
    const { stopPerfTimer } = useDebugPerformance('Setup Nuxt module', options.debug)

    // Pinceau runtime config (to be used with Nuxt Studio integration)
    nuxt.options.runtimeConfig.pinceau = { studio: options?.studio }

    // Local module resolver
    const modulePath = createResolver(import.meta.url)
    const resolveLocalModule = (path: string) => resolveModule(path, { paths: modulePath.resolve('./') })

    // Transpile pinceau
    nuxt.options.build.transpile = nuxt.options.build.transpile || []
    nuxt.options.build.transpile.push('pinceau', 'chroma-js')

    // Call options hook
    await nuxt.callHook('pinceau:options', options)

    // nuxt-component-meta support
    if (options.componentMetaSupport) {
      let cachedTokens
      // @ts-ignore
      nuxt.hook('component-meta:transformers', (transformers: any[]) => {
        transformers.push(
          (component, code) => {
            const flatPath = options.outputDir

            const resolvedTokens = []

            // Grab built tokens and resolve all tokens paths
            if (!cachedTokens && existsSync(join(flatPath, 'index.ts'))) {
              const _tokens = createJITI(flatPath)(join(flatPath, 'index.ts')).default
              walkTokens(
                _tokens?.theme || _tokens,
                (_, __, paths) => resolvedTokens.push(paths.join('.')),
              )
            }

            if (cachedTokens.length) {
              const referencesRegex = /\{([a-zA-Z].+)\}/g
              const matches: any = code.match(referencesRegex) || []

              matches.forEach(
                (match) => {
                  const _match = match.replace('{', '').replace('}', '')
                  if (cachedTokens.includes(_match) && !resolvedTokens.includes(_match)) { resolvedTokens.push(match) }
                },
              )
            }

            component.meta.tokens = resolvedTokens

            return { component, code }
          },
        )

        return transformers
      })
    }

    // Automatically inject generated types to tsconfig
    nuxt.hook('prepare:types', async (opts) => {
      const tsConfig: typeof opts.tsConfig & { vueCompilerOptions?: any } = opts.tsConfig
      tsConfig.compilerOptions = tsConfig.compilerOptions || {}
      tsConfig.compilerOptions.paths = tsConfig.compilerOptions.paths || {}

      if (options?.outputDir) {
        const relativeOutputDir = options.outputDir
        tsConfig.compilerOptions.paths['#pinceau/utils'] = [`${resolve(relativeOutputDir, 'utils.ts')}`]
        tsConfig.compilerOptions.paths['#pinceau/theme'] = [`${resolve(relativeOutputDir, 'index.ts')}`]
        if (options?.studio) { tsConfig.compilerOptions.paths['#pinceau/schema'] = [`${resolve(relativeOutputDir, 'schema.ts')}`] }
      }

      // Add Volar plugin
      tsConfig.vueCompilerOptions = tsConfig.vueCompilerOptions || {}
      tsConfig.vueCompilerOptions.plugins = tsConfig.vueCompilerOptions.plugins || []
      tsConfig.vueCompilerOptions.plugins.push('pinceau/volar')

      // Prepares the output dir
      await prepareOutputDir(options)
    })

    // Setup Nitro plugin
    if (!nuxt.options.nitro) { nuxt.options.nitro = {} }
    if (!nuxt.options.nitro.plugins) { nuxt.options.nitro.plugins = [] }
    nuxt.options.nitro.plugins.push(resolveLocalModule('./nitro'))

    // Support for `extends` feature
    // Will scan each layer for a config file
    const layerPaths = nuxt.options._layers.reduce(
      (acc: string[], layer: any) => {
        if (layer?.cwd) {
          acc.push(layer?.cwd)
        }
        return acc
      },
      [],
    )

    // Setup Nitro studio plugin
    if (options.studio) {
      // Add server route to know Studio is enabled
      addPlugin(resolveLocalModule('./runtime/schema.server'))
      addPrerenderRoutes('/__pinceau_tokens_config.json')
      addPrerenderRoutes('/__pinceau_tokens_schema.json')

      // Support custom ~/.studio/tokens.config.json
      nuxt.hook('app:resolve', () => {
        const studioAppConfigPath = resolveAlias('~/.studio/tokens.config.json')
        if (existsSync(studioAppConfigPath)) { layerPaths.unshift(studioAppConfigPath) }
      })
    }

    // Push layer paths into configOrPaths options
    layerPaths.forEach(
      (path: string) => {
        if (!(options?.configOrPaths as string[]).includes(path)) {
          (options.configOrPaths as string[]).push(path)
        }
      },
    )

    // Set `cwd` from Nuxt rootDir
    options.cwd = nuxt.options.rootDir

    // Automatically inject all components in layers into includes
    for (const layer of layerPaths) {
      options.includes?.push(
        ...await glob(
          join(layer, '**/*.vue'),
          { followSymbolicLinks: options.followSymbolicLinks },
        ),
      )
    }

    addPluginTemplate({
      filename: 'pinceau-nuxt-plugin.mjs',
      getContents() {
        const lines = [
          'import \'#build/pinceau/index.css\'',
        ]

        if (options.runtime) {
          lines.push(
            'import { useState } from \'#app\'',
            'import { plugin as pinceau } from \'pinceau/runtime\'',
            'import utils from \'#build/pinceau/utils\'',
            '',
            `export default defineNuxtPlugin(async (nuxtApp) => {
              let theme = {}

              // Get full theme server-side
              // This theme will be resolved from the stylesheet on client-side
              if (process.server) {
                const builtTheme = await import('#build/pinceau')
                theme = builtTheme?.theme || builtTheme
              }

              // Setup plugin
              nuxtApp.vueApp.use(pinceau, { colorSchemeMode: '${options.colorSchemeMode}', theme, utils })

              // Handle first render of SSR styles
              nuxtApp.hook('app:rendered', (app) => {
                const content = app.ssrContext.nuxt.vueApp.config.globalProperties.$pinceauSsr.get()
                app.ssrContext.event.pinceauContent = content
              })
            })`,
          )
        }

        if (options?.preflight) { lines.unshift('import \'@unocss/reset/tailwind.css\'') }

        return lines.join('\n')
      },
    })

    // Webpack plugin
    nuxt.hook('webpack:config', (config: any) => {
      config.plugins = config.plugins || []
      config.plugins.unshift(pinceau.webpack(options))
    })

    // Vite plugin
    nuxt.hook('vite:extend', (vite: any) => {
      vite.config.plugins = vite.config.plugins || []
      vite.config.plugins.push(pinceau.vite(options))
    })

    stopPerfTimer()
  },
})

export default module
