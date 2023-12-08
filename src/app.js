import { createElement } from 'react'
import { Helmet } from 'react-helmet-async'
import { extractCss, setup } from 'goober'
import useTheme, { ThemeProvider } from 'xelis-explorer/src/hooks/useTheme'
import { Outlet } from 'react-router-dom'

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
      {currentTheme === `xelis` && <link rel="preload" as="image" href="public/img/bg_xelis.jpg" />}
      {currentTheme === `light` && <link rel="preload" as="image" href="public/img/bg_xelis_light.jpg" />}
      {currentTheme === `dark` && <link rel="preload" as="image" href="public/img/bg_xelis_dark.jpg" />}
      {currentTheme !== `light` && <link rel="preload" as="image" href="public/img/white_background_black_logo.svg" type="image/svg+xml" />}
      {currentTheme === `light` && <link rel="preload" as="image" href="public/img/black_background_white_logo.svg" type="image/svg+xml" />}
      <style>{css}</style> {/* Don't use id="_goober" or css will flicker. Probably an issue with goober reseting css.*/}
    </Helmet>
    <Outlet />
  </>
}

function App() {
  return <ThemeProvider>
    <SubApp />
  </ThemeProvider>
}

export default App