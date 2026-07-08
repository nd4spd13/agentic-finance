import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Clad',
  description: 'Financial permissions middleware for AI agents',
  base: '/',
  theme: 'dark',

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Docs', items: [
        { text: 'Policy Reference', link: '/policy-reference' },
        { text: 'MCP Tools', link: '/mcp-tools' },
        { text: 'Architecture', link: '/architecture' },
      ]},
      { text: 'Guides', items: [
        { text: 'Integration Guide', link: '/integration-guides' },
        { text: 'Starter Policies', link: '/starter-policies' },
      ]},
      { text: 'Roadmap', items: [
        { text: 'Product Roadmap', link: '/roadmap' },
        { text: 'Plan: Desktop App', link: '/plans/desktop-app' },
        { text: 'Plan: SimpleFIN Adapter', link: '/plans/simplefin-adapter' },
      ]}
    ],

    sidebar: {
      '/': [
        {
          text: 'Getting Started',
          items: [
            { text: 'Home', link: '/' },
            { text: 'Quick Start', link: '/getting-started' }
          ]
        },
        {
          text: 'Policy Reference',
          items: [
            { text: 'Complete Reference', link: '/policy-reference' }
          ]
        },
        {
          text: 'MCP Tools',
          items: [
            { text: 'Tool Reference', link: '/mcp-tools' }
          ]
        },
        {
          text: 'Integration Guides',
          items: [
            { text: 'Claude Desktop Integration', link: '/integration-guides' },
            { text: 'Starter Policy Templates', link: '/starter-policies' }
          ]
        },
        {
          text: 'Architecture',
          items: [
            { text: 'System Overview', link: '/architecture' }
          ]
        },
        {
          text: 'Roadmap & Plans',
          items: [
            { text: 'Product Roadmap', link: '/roadmap' },
            { text: 'Plan: Desktop App', link: '/plans/desktop-app' },
            { text: 'Plan: SimpleFIN Adapter', link: '/plans/simplefin-adapter' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com' }
    ],

    footer: {
      message: 'Open source financial permissions middleware',
      copyright: 'Copyright © 2024 Clad Contributors'
    }
  }
})
