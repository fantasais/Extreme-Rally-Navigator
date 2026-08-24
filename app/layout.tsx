import type {Metadata} from "next";
import "./globals.css";
export const metadata:Metadata={title:"Extreme Rally Navigator v0.1",description:"Offline GPX rally navigation assistant",manifest:"/manifest.webmanifest",icons:{icon:"/favicon.svg"}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>}
