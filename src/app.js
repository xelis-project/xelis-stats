import { createElement } from 'react'
import { Helmet } from 'react-helmet-async'
import { extractCss, setup } from 'goober'
import useTheme, { ThemeProvider } from 'xelis-explorer/src/hooks/useTheme'
import { Outlet } from 'react-router-dom'
import { NotificationProvider } from 'xelis-explorer/src/components/notifications'
import { PreloadAssets } from 'xelis-explorer/src/components/preload'
import { favicon } from 'xelis-explorer/src/components/favicon'

import "reset-css/reset.css"

import 'xelis-explorer/src/style/theme'
import 'xelis-explorer/src/style/page'
import 'xelis-explorer/src/style/scrollbar'

setup(createElement) // this is for goober styled() func

let css = ``

function SubApp() {
  const { theme: currentTheme } = useTheme()

  if (!css) {
    css = extractCss()
  }

  return <>
    <Helmet titleTemplate='%s · XELIS Stats'>
      {favicon()}
      <style>{css}</style> {/* Don't use id="_goober" or css will flicker. Probably an issue with goober reseting css.*/}
    </Helmet>
    <PreloadAssets />
    <Outlet />
  </>
}

function App() {
  return <ThemeProvider>
    <NotificationProvider>
      <SubApp />
    </NotificationProvider>
  </ThemeProvider>
}

export default App