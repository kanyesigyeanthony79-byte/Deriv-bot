//+------------------------------------------------------------------+
//| Deriv Signal Assistant V2 - Server-Connected Synthetic EA        |
//| Demo-only. Executes existing MTF server signals; no local signals |
//+------------------------------------------------------------------+
#property copyright "Deriv Signal Assistant"
#property version   "2.11"
#property strict

#include <Trade/Trade.mqh>
CTrade trade;

input bool   InpEnableTrading = false; // Keep false until demo validation is complete
input bool   InpObserveOnly = true;    // Receive/validate signals without sending orders
input string InpBridgeUrl = "https://deriv-telegram-alerts.kanyesigyeanthony79-451.workers.dev";
input string InpApiKey = "";           // Same value as GitHub SIGNAL_API_KEY
input string InpClientId = "MT5-DEMO-01";
input string InpSymbolMap = "R_10=Volatility 10 Index;R_25=Volatility 25 Index;R_50=Volatility 50 Index;R_75=Volatility 75 Index;JD100=Jump 100 Index;CRASH500=Crash 500 Index;BOOM500=Boom 500 Index";

input int    InpEntriesPerSignal = 3;
input double InpRiskPerBasket = 15.0;  // Account currency must be USD
input double InpTargetProfit = 30.0;   // Expected full-basket profit if all three targets fill; informational only
input double InpDailyLossLimitPct = 3.0;
input double InpMaxEntryDeviationR = 0.20;
input int    InpPollSeconds = 3;
input int    InpHttpTimeoutMs = 7000;
input int    InpDeviationPoints = 30;
input ulong  InpMagicNumber = 20261117;

string AllowedMarkets[] = {"R_10","R_25","R_50","R_75","JD100","CRASH500","BOOM500"};
double DayStartEquity = 0.0;
string DayKey = "";
datetime LastHealthCheck = 0;

//+------------------------------------------------------------------+
bool IsAllowedMarket(const string marketId)
{
   for(int i=0; i<ArraySize(AllowedMarkets); i++)
      if(marketId == AllowedMarkets[i]) return true;
   return false;
}

//+------------------------------------------------------------------+
string ResolveBrokerSymbol(const string marketId)
{
   string entries[];
   ushort sep = StringGetCharacter(";",0);
   int n = StringSplit(InpSymbolMap,sep,entries);
   for(int i=0; i<n; i++)
   {
      string item = entries[i];
      StringTrimLeft(item); StringTrimRight(item);
      int eq = StringFind(item,"=");
      if(eq <= 0) continue;
      string key = StringSubstr(item,0,eq);
      string value = StringSubstr(item,eq+1);
      StringTrimLeft(key); StringTrimRight(key);
      StringTrimLeft(value); StringTrimRight(value);
      if(key == marketId) return value;
   }
   return "";
}

//+------------------------------------------------------------------+
string JsonGetString(const string json,const string key)
{
   string token = "\"" + key + "\"";
   int p = StringFind(json,token);
   if(p < 0) return "";
   p = StringFind(json,":",p);
   if(p < 0) return "";
   p++;
   while(p < StringLen(json) && StringGetCharacter(json,p) <= 32) p++;
   if(p >= StringLen(json) || StringGetCharacter(json,p) != '"') return "";
   p++;
   int start = p;
   bool escaped = false;
   while(p < StringLen(json))
   {
      ushort c = StringGetCharacter(json,p);
      if(c == '"' && !escaped) break;
      if(c == '\\' && !escaped) escaped = true;
      else escaped = false;
      p++;
   }
   if(p <= start) return "";
   return StringSubstr(json,start,p-start);
}

//+------------------------------------------------------------------+
double JsonGetNumber(const string json,const string key)
{
   string token = "\"" + key + "\"";
   int p = StringFind(json,token);
   if(p < 0) return -1.0;
   p = StringFind(json,":",p);
   if(p < 0) return -1.0;
   p++;
   while(p < StringLen(json) && StringGetCharacter(json,p) <= 32) p++;
   int start = p;
   while(p < StringLen(json))
   {
      ushort c = StringGetCharacter(json,p);
      if(c == ',' || c == '}' || c == ']' || c <= 32) break;
      p++;
   }
   if(p <= start) return -1.0;
   return StringToDouble(StringSubstr(json,start,p-start));
}

//+------------------------------------------------------------------+
string JsonGetObject(const string json,const string key)
{
   string token = "\"" + key + "\"";
   int p = StringFind(json,token);
   if(p < 0) return "";
   p = StringFind(json,":",p);
   if(p < 0) return "";
   p = StringFind(json,"{",p);
   if(p < 0) return "";
   int start = p, depth = 0;
   bool inString = false, escaped = false;
   for(int i=p; i<StringLen(json); i++)
   {
      ushort c = StringGetCharacter(json,i);
      if(inString)
      {
         if(c == '"' && !escaped) inString = false;
         if(c == '\\' && !escaped) escaped = true;
         else escaped = false;
         continue;
      }
      if(c == '"') { inString = true; escaped = false; continue; }
      if(c == '{') depth++;
      if(c == '}')
      {
         depth--;
         if(depth == 0) return StringSubstr(json,start,i-start+1);
      }
   }
   return "";
}

//+------------------------------------------------------------------+
bool JsonTrue(const string json,const string key)
{
   string token = "\"" + key + "\":true";
   return (StringFind(json,token) >= 0);
}

//+------------------------------------------------------------------+
int HttpGet(const string url,string &response)
{
   char data[];
   ArrayResize(data,0);
   char result[];
   string resultHeaders;
   string headers = "X-API-Key: " + InpApiKey + "\r\n";
   ResetLastError();
   int status = WebRequest("GET",url,headers,InpHttpTimeoutMs,data,result,resultHeaders);
   if(status == -1)
   {
      Print("WebRequest GET failed. Error ",GetLastError(),
            ". Add the bridge URL under MT5 Tools > Options > Expert Advisors > Allow WebRequest.");
      return -1;
   }
   response = CharArrayToString(result,0,-1,CP_UTF8);
   return status;
}

//+------------------------------------------------------------------+
int HttpPost(const string url,const string body,string &response)
{
   char data[];
   int copied = StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);
   if(copied > 0) ArrayResize(data,copied-1);
   char result[];
   string resultHeaders;
   string headers = "X-API-Key: " + InpApiKey + "\r\nContent-Type: application/json\r\n";
   ResetLastError();
   int status = WebRequest("POST",url,headers,InpHttpTimeoutMs,data,result,resultHeaders);
   if(status == -1)
   {
      Print("WebRequest POST failed. Error ",GetLastError());
      return -1;
   }
   response = CharArrayToString(result,0,-1,CP_UTF8);
   return status;
}

//+------------------------------------------------------------------+
string ProcessedKey(const string signalId)
{
   uint h = 2166136261;
   for(int i=0; i<StringLen(signalId); i++)
      h = (h ^ (uint)StringGetCharacter(signalId,i)) * 16777619;
   return "DSA2_SIG_" + IntegerToString((long)h);
}

//+------------------------------------------------------------------+
bool WasProcessed(const string signalId)
{
   return GlobalVariableCheck(ProcessedKey(signalId));
}

//+------------------------------------------------------------------+
void MarkProcessed(const string signalId)
{
   GlobalVariableSet(ProcessedKey(signalId),(double)TimeCurrent());
}

//+------------------------------------------------------------------+
bool AcknowledgeSignal(const string signalId,const string status)
{
   string body = "{\"signalId\":\"" + signalId + "\",\"clientId\":\"" +
                 InpClientId + "\",\"status\":\"" + status + "\"}";
   string response;
   int http = HttpPost(InpBridgeUrl + "/mt5/ack",body,response);
   if(http != 200 || !JsonTrue(response,"success"))
   {
      Print("Signal acknowledgement failed for ",signalId,
            ". HTTP=",http," response=",response);
      return false;
   }
   Print("Signal ",signalId," acknowledged: ",status);
   return true;
}

//+------------------------------------------------------------------+
string PositionMapFileName(const ulong positionId)
{
   return "DSA2_" + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) +
          "_" + IntegerToString((long)positionId) + ".map";
}

//+------------------------------------------------------------------+
bool SavePositionMap(const ulong positionId,const string signalId,
                     const string marketId,const string category,
                     const string direction,const string targetLeg,
                     const double entryPrice,const double stopLoss,
                     const double tp1,const double tp2,const double volume,
                     const string symbol)
{
   int handle = FileOpen(PositionMapFileName(positionId),
                         FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle == INVALID_HANDLE)
   {
      Print("Could not persist trade map for position ",positionId,
            ". Error ",GetLastError());
      return false;
   }
   string row = signalId+"|"+marketId+"|"+category+"|"+direction+"|"+
                targetLeg+"|"+DoubleToString(entryPrice,8)+"|"+
                DoubleToString(stopLoss,8)+"|"+DoubleToString(tp1,8)+"|"+
                DoubleToString(tp2,8)+"|"+DoubleToString(volume,8)+"|"+symbol;
   FileWriteString(handle,row);
   FileClose(handle);
   return true;
}

//+------------------------------------------------------------------+
bool LoadPositionMap(const ulong positionId,string &signalId,
                     string &marketId,string &category,string &direction,
                     string &targetLeg,double &entryPrice,double &stopLoss,
                     double &tp1,double &tp2,double &entryVolume,string &symbol)
{
   int handle = FileOpen(PositionMapFileName(positionId),
                         FILE_READ|FILE_TXT|FILE_ANSI|FILE_COMMON);
   if(handle == INVALID_HANDLE) return false;
   string row = FileReadString(handle);
   FileClose(handle);
   string fields[];
   ushort delimiter = (ushort)StringGetCharacter("|",0);
   int count = StringSplit(row,delimiter,fields);
   if(count < 11) return false;
   signalId = fields[0]; marketId = fields[1]; category = fields[2];
   direction = fields[3]; targetLeg = fields[4];
   entryPrice = StringToDouble(fields[5]); stopLoss = StringToDouble(fields[6]);
   tp1 = StringToDouble(fields[7]); tp2 = StringToDouble(fields[8]);
   entryVolume = StringToDouble(fields[9]); symbol = fields[10];
   return (signalId!="" && marketId!="" && (targetLeg=="TP1" || targetLeg=="TP2"));
}

//+------------------------------------------------------------------+
bool PositionIdentifierIsOpen(const ulong positionId)
{
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket==0) continue;
      if((ulong)PositionGetInteger(POSITION_IDENTIFIER)==positionId) return true;
   }
   return false;
}

//+------------------------------------------------------------------+
string ProcessedDealKey(const ulong dealTicket)
{
   return "DSA2_DEAL_"+IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN))+
          "_"+IntegerToString((long)dealTicket);
}

//+------------------------------------------------------------------+
bool ReportClosedPosition(const ulong closingDeal,const ulong positionId)
{
   string signalId,marketId,category,direction,targetLeg,symbol;
   double entryPrice,stopLoss,tp1,tp2,entryVolume;
   if(!LoadPositionMap(positionId,signalId,marketId,category,direction,targetLeg,
                       entryPrice,stopLoss,tp1,tp2,entryVolume,symbol))
      return false;
   if(!HistorySelectByPosition(positionId)) return false;

   int total = HistoryDealsTotal();
   double realized = 0.0, closeVolume = 0.0, closeValue = 0.0;
   long latestCloseTimeMsc = -1, closeReason = -1;
   ulong latestCloseDeal = 0;
   datetime closeTime = 0;
   for(int i=0; i<total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket==0) continue;
      realized += HistoryDealGetDouble(ticket,DEAL_PROFIT);
      realized += HistoryDealGetDouble(ticket,DEAL_COMMISSION);
      realized += HistoryDealGetDouble(ticket,DEAL_SWAP);
      realized += HistoryDealGetDouble(ticket,DEAL_FEE);
      long entryType = HistoryDealGetInteger(ticket,DEAL_ENTRY);
      if(entryType==DEAL_ENTRY_OUT || entryType==DEAL_ENTRY_OUT_BY ||
         entryType==DEAL_ENTRY_INOUT)
      {
         double vol = HistoryDealGetDouble(ticket,DEAL_VOLUME);
         closeVolume += vol;
         closeValue += HistoryDealGetDouble(ticket,DEAL_PRICE)*vol;
         long timeMsc = HistoryDealGetInteger(ticket,DEAL_TIME_MSC);
         if(timeMsc >= latestCloseTimeMsc)
         {
            latestCloseTimeMsc = timeMsc;
            latestCloseDeal = ticket;
            closeReason = HistoryDealGetInteger(ticket,DEAL_REASON);
            closeTime = (datetime)HistoryDealGetInteger(ticket,DEAL_TIME);
         }
      }
   }
   // Send one final, aggregated record per position, not one per partial fill.
   if(closeVolume<=0.0) return false;
   if(latestCloseDeal!=closingDeal)
   {
      GlobalVariableSet(ProcessedDealKey(closingDeal),(double)TimeCurrent());
      return false;
   }
   double closePrice = closeValue/closeVolume;
   string reason = "OTHER";
   if(closeReason==DEAL_REASON_TP) reason = "TP";
   else if(closeReason==DEAL_REASON_SL) reason = "SL";
   else if(closeReason==DEAL_REASON_CLIENT) reason = "MANUAL";

   string body = "{\"event\":\"position_closed\",\"signalId\":\""+signalId+
      "\",\"clientId\":\""+InpClientId+"\",\"dealTicket\":\""+
      IntegerToString((long)closingDeal)+"\",\"positionId\":\""+
      IntegerToString((long)positionId)+"\",\"marketId\":\""+marketId+
      "\",\"market\":\""+symbol+"\",\"category\":\""+category+
      "\",\"direction\":\""+direction+"\",\"targetLeg\":\""+targetLeg+
      "\",\"closeReason\":\""+reason+"\",\"entryPrice\":"+
      DoubleToString(entryPrice,8)+",\"stopLoss\":"+DoubleToString(stopLoss,8)+
      ",\"tp1\":"+DoubleToString(tp1,8)+",\"tp2\":"+DoubleToString(tp2,8)+
      ",\"closePrice\":"+DoubleToString(closePrice,8)+",\"volume\":"+
      DoubleToString(closeVolume,8)+",\"realizedProfit\":"+DoubleToString(realized,2)+
      ",\"closeTime\":"+IntegerToString((long)closeTime)+
      ",\"accountCurrency\":\""+AccountInfoString(ACCOUNT_CURRENCY)+"\",\"accountMode\":\"DEMO\"}";
   string response;
   int http = HttpPost(InpBridgeUrl+"/mt5/trade-event",body,response);
   if(http!=200 || !JsonTrue(response,"success"))
   {
      Print("MT5 closure report failed for position ",positionId,
            ". HTTP=",http," response=",response);
      return false;
   }
   for(int processedIndex=0; processedIndex<HistoryDealsTotal(); processedIndex++)
   {
      ulong processedTicket=HistoryDealGetTicket(processedIndex);
      if(processedTicket==0) continue;
      long processedEntry=HistoryDealGetInteger(processedTicket,DEAL_ENTRY);
      if(processedEntry==DEAL_ENTRY_OUT || processedEntry==DEAL_ENTRY_OUT_BY || processedEntry==DEAL_ENTRY_INOUT)
         GlobalVariableSet(ProcessedDealKey(processedTicket),(double)TimeCurrent());
   }
   FileDelete(PositionMapFileName(positionId),FILE_COMMON);
   Print("MT5 position closure reported. Signal=",signalId,
         " leg=",targetLeg," reason=",reason,
         " net realized P/L=",DoubleToString(realized,2));
   return true;
}

//+------------------------------------------------------------------+
void SyncClosedTradeDeals()
{
   datetime now = TimeCurrent();
   if(!HistorySelect(now-60*86400,now+60)) return;
   ulong candidates[];
   int total = HistoryDealsTotal();
   for(int i=0; i<total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket==0 || GlobalVariableCheck(ProcessedDealKey(ticket))) continue;
      if((ulong)HistoryDealGetInteger(ticket,DEAL_MAGIC)!=InpMagicNumber) continue;
      long entryType = HistoryDealGetInteger(ticket,DEAL_ENTRY);
      if(entryType!=DEAL_ENTRY_OUT && entryType!=DEAL_ENTRY_OUT_BY &&
         entryType!=DEAL_ENTRY_INOUT) continue;
      ArrayResize(candidates,ArraySize(candidates)+1);
      candidates[ArraySize(candidates)-1]=ticket;
   }
   for(int i=0; i<ArraySize(candidates); i++)
   {
      ulong ticket=candidates[i];
      if(!HistoryDealSelect(ticket)) continue;
      ulong positionId=(ulong)HistoryDealGetInteger(ticket,DEAL_POSITION_ID);
      if(positionId==0 || PositionIdentifierIsOpen(positionId)) continue;
      ReportClosedPosition(ticket,positionId);
   }
}

//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
string OpenReportedKey(const string signalId)
{
   uint h=2166136261;
   for(int i=0; i<StringLen(signalId); i++)
      h=(h ^ (uint)StringGetCharacter(signalId,i))*16777619;
   return "DSA2_OPEN_"+IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN))+
          "_"+IntegerToString((long)h);
}

//+------------------------------------------------------------------+
void SyncOpenTradeBaskets()
{
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0 || (ulong)PositionGetInteger(POSITION_MAGIC)!=InpMagicNumber) continue;
      ulong positionId=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
      string signalId,marketId,category,direction,targetLeg,symbol;
      double entryPrice,stopLoss,tp1,tp2,entryVolume;
      if(!LoadPositionMap(positionId,signalId,marketId,category,direction,targetLeg,
                          entryPrice,stopLoss,tp1,tp2,entryVolume,symbol)) continue;
      string reportKey=OpenReportedKey(signalId);
      if(GlobalVariableCheck(reportKey)) continue;

      ulong positionIds[3];
      double fillPrices[3],volumes[3];
      string targetLegs[3];
      int found=0;
      double weightedEntry=0.0,totalVolume=0.0;
      for(int j=PositionsTotal()-1; j>=0; j--)
      {
         ulong otherTicket=PositionGetTicket(j);
         if(otherTicket==0 || (ulong)PositionGetInteger(POSITION_MAGIC)!=InpMagicNumber) continue;
         ulong otherId=(ulong)PositionGetInteger(POSITION_IDENTIFIER);
         string otherSignal,otherMarket,otherCategory,otherDirection,otherLeg,otherSymbol;
         double otherEntry,otherStop,otherTp1,otherTp2,otherVolume;
         if(!LoadPositionMap(otherId,otherSignal,otherMarket,otherCategory,otherDirection,otherLeg,
                             otherEntry,otherStop,otherTp1,otherTp2,otherVolume,otherSymbol)) continue;
         if(otherSignal!=signalId || found>=3) continue;
         double liveEntry=PositionGetDouble(POSITION_PRICE_OPEN);
         double liveVolume=PositionGetDouble(POSITION_VOLUME);
         positionIds[found]=otherId;
         fillPrices[found]=liveEntry;
         volumes[found]=liveVolume;
         targetLegs[found]=otherLeg;
         weightedEntry+=liveEntry*liveVolume;
         totalVolume+=liveVolume;
         found++;
      }
      if(found!=3 || totalVolume<=0.0) continue;

      string positionsJson="[";
      for(int n=0; n<found; n++)
      {
         if(n>0) positionsJson+=",";
         positionsJson+="{\"positionId\":\""+IntegerToString((long)positionIds[n])+
            "\",\"targetLeg\":\""+targetLegs[n]+"\",\"entryPrice\":"+
            DoubleToString(fillPrices[n],8)+",\"volume\":"+DoubleToString(volumes[n],8)+"}";
      }
      positionsJson+="]";
      string body="{\"event\":\"basket_opened\",\"signalId\":\""+signalId+
         "\",\"clientId\":\""+InpClientId+"\",\"marketId\":\""+marketId+
         "\",\"market\":\""+symbol+"\",\"category\":\""+category+
         "\",\"direction\":\""+direction+"\",\"entryPrice\":"+
         DoubleToString(weightedEntry/totalVolume,8)+",\"stopLoss\":"+
         DoubleToString(stopLoss,8)+",\"tp1\":"+DoubleToString(tp1,8)+
         ",\"tp2\":"+DoubleToString(tp2,8)+",\"positions\":"+positionsJson+
         ",\"accountCurrency\":\""+AccountInfoString(ACCOUNT_CURRENCY)+
         "\",\"accountMode\":\"DEMO\"}";
      string response;
      int http=HttpPost(InpBridgeUrl+"/mt5/basket-opened",body,response);
      if(http==200 && JsonTrue(response,"success"))
      {
         GlobalVariableSet(reportKey,(double)TimeCurrent());
         Print("MT5 basket-open event reported for ",signalId," with three positions.");
      }
      else
      {
         Print("MT5 basket-open report failed for ",signalId,
               ". HTTP=",http," response=",response);
      }
   }
}

//+------------------------------------------------------------------+

//+------------------------------------------------------------------+
string CurrentDayKey()
{
   string d = TimeToString(TimeCurrent(),TIME_DATE);
   StringReplace(d,".","");
   return "DSA2_DAY_" + (string)AccountInfoInteger(ACCOUNT_LOGIN) + "_" + d;
}

//+------------------------------------------------------------------+
void RefreshDailyBaseline()
{
   string key = CurrentDayKey();
   if(key != DayKey)
   {
      DayKey = key;
      if(GlobalVariableCheck(DayKey))
         DayStartEquity = GlobalVariableGet(DayKey);
      else
      {
         DayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
         GlobalVariableSet(DayKey,DayStartEquity);
      }
   }
}

//+------------------------------------------------------------------+
bool DailyLossLimitReached()
{
   RefreshDailyBaseline();
   if(DayStartEquity <= 0.0) return false;
   double floorEquity = DayStartEquity * (1.0 - InpDailyLossLimitPct/100.0);
   return AccountInfoDouble(ACCOUNT_EQUITY) <= floorEquity;
}

//+------------------------------------------------------------------+
int CountOurPositions()
{
   int count = 0;
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) == InpMagicNumber) count++;
   }
   return count;
}

//+------------------------------------------------------------------+
double BasketFloatingProfit()
{
   double total = 0.0;
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;
      total += PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
   }
   return total;
}

//+------------------------------------------------------------------+
bool CloseAllOurPositions()
{
   bool allClosed = true;
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpDeviationPoints);
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;
      if(!trade.PositionClose(ticket) ||
         (trade.ResultRetcode() != TRADE_RETCODE_DONE &&
          trade.ResultRetcode() != TRADE_RETCODE_DONE_PARTIAL))
      {
         allClosed = false;
         Print("Could not close position ",ticket,": ",trade.ResultRetcodeDescription());
      }
   }
   return allClosed;
}

//+------------------------------------------------------------------+
void ManageBasket()
{
   int count = CountOurPositions();
   if(count <= 0) return;

   // TP1 and TP2 are attached to the individual positions at entry:
   // entries 1 and 2 close at TP1; entry 3 remains open for TP2.
   // Keep only the basket-wide emergency loss guard here.
   double pnl = BasketFloatingProfit();
   if(pnl <= -InpRiskPerBasket)
   {
      Print("Emergency basket loss limit reached: ",DoubleToString(pnl,2),
            ". Closing all remaining EA positions.");
      CloseAllOurPositions();
   }
}

//+------------------------------------------------------------------+
double NormalizeVolumeDown(const string symbol,const double requested)
{
   double minVol = SymbolInfoDouble(symbol,SYMBOL_VOLUME_MIN);
   double maxVol = SymbolInfoDouble(symbol,SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP);
   if(minVol <= 0.0 || maxVol <= 0.0 || step <= 0.0) return 0.0;
   double volume = MathMin(maxVol,requested);
   volume = MathFloor(volume/step + 1e-9) * step;
   if(volume + 1e-9 < minVol) return 0.0;
   int digits = 2;
   if(step < 0.01) digits = 3;
   if(step < 0.001) digits = 4;
   if(step < 0.0001) digits = 5;
   return NormalizeDouble(volume,digits);
}

//+------------------------------------------------------------------+
bool OpenSignalBasket(const string signalId,const string marketId,
                      const string direction,const double signalEntry,
                      const double stopLoss,const double tp1,const double tp2,
                      const double signalAge,const string category)
{
   if(!IsAllowedMarket(marketId)) { Print("Rejected non-whitelisted market: ",marketId); return false; }
   if(category == "SWING") { Print("SWING signals are not executable."); return false; }
   string symbol = ResolveBrokerSymbol(marketId);
   if(symbol == "") { Print("No MT5 symbol mapping for ",marketId); return false; }
   if(!SymbolSelect(symbol,true)) { Print("Could not select broker symbol ",symbol); return false; }

   MqlTick tick;
   if(!SymbolInfoTick(symbol,tick)) { Print("No quote for ",symbol); return false; }
   bool isBuy = (direction == "BUY");
   if(!isBuy && direction != "SELL") return false;
   double price = isBuy ? tick.ask : tick.bid;
   double riskDistance = MathAbs(signalEntry-stopLoss);
   if(riskDistance <= 0.0) return false;
   if(isBuy && !(stopLoss < signalEntry && tp1 > signalEntry && tp2 > tp1))
   {
      Print("BUY signal has inconsistent SL/TP ordering.");
      return false;
   }
   if(!isBuy && !(stopLoss > signalEntry && tp1 < signalEntry && tp2 < tp1))
   {
      Print("SELL signal has inconsistent SL/TP ordering.");
      return false;
   }
   if(MathAbs(price-signalEntry) > riskDistance*InpMaxEntryDeviationR)
   {
      Print("Signal rejected: current price moved too far from entry on ",symbol);
      return false;
   }
   if(isBuy && price >= tp1) { Print("Signal rejected: TP1 already passed."); return false; }
   if(!isBuy && price <= tp1) { Print("Signal rejected: TP1 already passed."); return false; }

   double point = SymbolInfoDouble(symbol,SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(symbol,SYMBOL_DIGITS);
   long stopsLevel = SymbolInfoInteger(symbol,SYMBOL_TRADE_STOPS_LEVEL);
   if(point <= 0.0) return false;
   double minStopDistance = (double)stopsLevel*point;
   double sl = NormalizeDouble(stopLoss,digits);
   double tp1Price = NormalizeDouble(tp1,digits);
   double tp2Price = NormalizeDouble(tp2,digits);
   if(isBuy)
   {
      if((price-sl) <= minStopDistance) { Print("Stop loss is too close for broker rules."); return false; }
      if((tp1Price-price) <= minStopDistance || (tp2Price-price) <= minStopDistance)
      {
         Print("TP1 or TP2 is too close to the current price for broker rules.");
         return false;
      }
   }
   else
   {
      if((sl-price) <= minStopDistance) { Print("Stop loss is too close for broker rules."); return false; }
      if((price-tp1Price) <= minStopDistance || (price-tp2Price) <= minStopDistance)
      {
         Print("TP1 or TP2 is too close to the current price for broker rules.");
         return false;
      }
   }
   ENUM_ORDER_TYPE orderType = isBuy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double oneLotPnl = 0.0;
   if(!OrderCalcProfit(orderType,symbol,1.0,price,sl,oneLotPnl))
   {
      Print("OrderCalcProfit failed for ",symbol,". Error ",GetLastError());
      return false;
   }
   double riskPerLot = MathAbs(oneLotPnl);
   if(riskPerLot <= 0.0) return false;
   double riskPerEntry = InpRiskPerBasket/(double)InpEntriesPerSignal;
   double volume = NormalizeVolumeDown(symbol,riskPerEntry/riskPerLot);
   if(volume <= 0.0)
   {
      Print("Broker minimum lot would exceed the per-entry risk budget on ",symbol,
            ". Signal skipped rather than increasing risk.");
      return false;
   }
   double actualPnl = 0.0;
   if(!OrderCalcProfit(orderType,symbol,volume,price,sl,actualPnl)) return false;
   double actualRiskPerEntry = MathAbs(actualPnl);
   if(actualRiskPerEntry > riskPerEntry + 0.01)
   {
      Print("Normalized volume exceeds risk budget. Basket skipped.");
      return false;
   }

   double margin = 0.0;
   if(!OrderCalcMargin(orderType,symbol,volume,price,margin))
   {
      Print("Could not calculate margin for ",symbol);
      return false;
   }
   if(AccountInfoDouble(ACCOUNT_MARGIN_FREE) < margin*InpEntriesPerSignal*1.10)
   {
      Print("Insufficient free margin for all three entries on ",symbol);
      return false;
   }

   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpDeviationPoints);
   trade.SetTypeFillingBySymbol(symbol);
   string tag = "DSA2-" + StringSubstr(signalId,0,18);
   int opened = 0;
   double actualRiskTotal = 0.0;
   ulong positionIds[];
   double filledPrices[];
   double filledVolumes[];
   ArrayResize(positionIds,InpEntriesPerSignal);
   ArrayResize(filledPrices,InpEntriesPerSignal);
   ArrayResize(filledVolumes,InpEntriesPerSignal);
   for(int n=1; n<=InpEntriesPerSignal; n++)
   {
      // Recheck price before every order; abort and roll back if the signal has moved.
      MqlTick latestTick;
      if(!SymbolInfoTick(symbol,latestTick))
      {
         CloseAllOurPositions();
         return false;
      }
      double latestPrice = isBuy ? latestTick.ask : latestTick.bid;
      if(MathAbs(latestPrice-signalEntry) > riskDistance*InpMaxEntryDeviationR ||
         (isBuy && latestPrice >= tp1Price) || (!isBuy && latestPrice <= tp1Price))
      {
         Print("Price moved outside the valid signal window during basket submission. Rolling back.");
         CloseAllOurPositions();
         return false;
      }

      // Two separate positions carry TP1; the third carries TP2.
       double positionTp = (n <= 2 ? tp1Price : tp2Price);
       string positionTag = tag + (n <= 2 ? "-TP1" : "-TP2");
       bool sent = isBuy ? trade.Buy(volume,symbol,0.0,sl,positionTp,positionTag)
                         : trade.Sell(volume,symbol,0.0,sl,positionTp,positionTag);
      uint rc = trade.ResultRetcode();
      double filled = trade.ResultVolume();
      double fillPrice = trade.ResultPrice();
      if(sent && rc == TRADE_RETCODE_DONE &&
         MathAbs(filled-volume) <= SymbolInfoDouble(symbol,SYMBOL_VOLUME_STEP)*0.5)
      {
         double fillPnl = 0.0;
         if(fillPrice <= 0.0 || !OrderCalcProfit(orderType,symbol,filled,fillPrice,sl,fillPnl))
         {
            Print("Could not verify actual filled risk. Rolling back.");
            CloseAllOurPositions();
            return false;
         }
         actualRiskTotal += MathAbs(fillPnl);
         if(actualRiskTotal > InpRiskPerBasket + 0.05)
         {
            Print("Actual filled prices pushed basket risk above USD ",
                  DoubleToString(InpRiskPerBasket,2), ". Rolling back.");
            CloseAllOurPositions();
            return false;
         }
         ulong openingDeal = trade.ResultDeal();
         if(openingDeal==0 || !HistoryDealSelect(openingDeal))
         {
            Print("Could not identify opening deal for entry ",n,". Rolling back.");
            CloseAllOurPositions();
            return false;
         }
         ulong positionId = (ulong)HistoryDealGetInteger(openingDeal,DEAL_POSITION_ID);
         if(positionId==0)
         {
            Print("Broker did not return a position identifier for entry ",n,". Rolling back.");
            CloseAllOurPositions();
            return false;
         }
         positionIds[opened]=positionId;
         filledPrices[opened]=fillPrice;
         filledVolumes[opened]=filled;
         opened++;
         Print("Basket entry ",opened,"/",InpEntriesPerSignal," opened on ",symbol,
               " volume=",DoubleToString(filled,4),
               " estimated fill risk=",DoubleToString(MathAbs(fillPnl),2));
      }
      else
      {
         Print("Entry ",n," failed or was partial on ",symbol,
               ". Retcode=",rc," ",trade.ResultRetcodeDescription(),
               ". Rolling back any opened entries.");
         CloseAllOurPositions();
         return false;
      }
   }

   if(opened != InpEntriesPerSignal || CountOurPositions() != InpEntriesPerSignal)
   {
      Print("Basket did not reach exactly three positions. Rolling back.");
      CloseAllOurPositions();
      return false;
   }
   for(int mapIndex=0; mapIndex<opened; mapIndex++)
   {
      string leg = (mapIndex<2 ? "TP1" : "TP2");
      if(!SavePositionMap(positionIds[mapIndex],signalId,marketId,category,direction,leg,
                          filledPrices[mapIndex],sl,tp1Price,tp2Price,filledVolumes[mapIndex],symbol))
      {
         for(int cleanup=0; cleanup<mapIndex; cleanup++)
            FileDelete(PositionMapFileName(positionIds[cleanup]),FILE_COMMON);
         Print("Trade mapping could not be persisted. Rolling back the entire basket.");
         CloseAllOurPositions();
         return false;
      }
   }
   Print("Basket opened for signal ",signalId,". Estimated total SL risk=",
         DoubleToString(actualRiskPerEntry*InpEntriesPerSignal,2),
         ", target=",DoubleToString(InpTargetProfit,2));
   return true;
}

//+------------------------------------------------------------------+
void PollSignalQueue()
{
   if(CountOurPositions() > 0) return;
   string response;
   string url = InpBridgeUrl + "/mt5/next?clientId=" + InpClientId;
   int http = HttpGet(url,response);
   if(http != 200)
   {
      if(http != -1) Print("Signal poll returned HTTP ",http,": ",response);
      return;
   }
   if(StringFind(response,"\"signal\":null") >= 0) return;
   string signal = JsonGetObject(response,"signal");
   if(signal == "") { Print("Could not parse signal response: ",response); return; }

   string signalId = JsonGetString(signal,"signalId");
   string marketId = JsonGetString(signal,"marketId");
   string direction = JsonGetString(signal,"direction");
   string category = JsonGetString(signal,"category");
   string priceValidation = JsonGetString(signal,"priceValidation");
   double entry = JsonGetNumber(signal,"entry");
   double stopLoss = JsonGetNumber(signal,"stopLoss");
   double tp1 = JsonGetNumber(signal,"tp1");
   double tp2 = JsonGetNumber(signal,"tp2");
   double signalAge = JsonGetNumber(response,"signalAgeSeconds");
   if(signalId == "" || marketId == "" || direction == "" ||
      priceValidation != "PASS" || entry <= 0.0 || stopLoss <= 0.0 || tp1 <= 0.0 || tp2 <= 0.0)
   {
      Print("Signal rejected due to missing or invalid fields.");
      if(signalId != "") AcknowledgeSignal(signalId,"rejected");
      return;
   }

   if(WasProcessed(signalId))
   {
      Print("Duplicate signal blocked locally: ",signalId);
      AcknowledgeSignal(signalId,"accepted");
      return;
   }

   if(!IsAllowedMarket(marketId) || category == "SWING")
   {
      MarkProcessed(signalId);
      AcknowledgeSignal(signalId,"rejected");
      Print("Unsupported signal rejected: ",marketId," / ",category);
      return;
   }

   int maxAge = (category == "SCALP" ? 600 : category == "SHORT_TERM" ? 1800 : category == "POSITION" ? 14400 : 0);
   if(maxAge == 0 || signalAge < 0.0 || signalAge > maxAge)
   {
      MarkProcessed(signalId);
      AcknowledgeSignal(signalId,"rejected");
      Print("Stale or unsupported signal category rejected: ",signalId);
      return;
   }

   // Observation mode is a hard no-order path. It records and acknowledges signals
   // without ever calling the order-opening function.
   if(InpObserveOnly)
   {
      MarkProcessed(signalId);
      Print("OBSERVATION ONLY: signal received and validated. ID=",signalId,
            " market=",marketId," direction=",direction,
            " category=",category," entry=",DoubleToString(entry,8),
            " SL=",DoubleToString(stopLoss,8)," TP1=",DoubleToString(tp1,8),
            " TP2=",DoubleToString(tp2,8),". No orders were sent.");
      AcknowledgeSignal(signalId,"observed");
      return;
   }

   // Do not mark the signal processed until execution outcome is known.
   // This prevents a failed order attempt from being mistaken for an executed basket
   // after a restart or a repeated queue delivery.
   bool opened = OpenSignalBasket(signalId,marketId,direction,entry,stopLoss,tp1,tp2,signalAge,category);
   int remainingPositions = CountOurPositions();
   if(opened || remainingPositions > 0)
   {
      // Persist before acknowledgement: if the acknowledgement fails, a redelivery
      // must not open a duplicate basket. Any residual exposure remains basket-managed.
      MarkProcessed(signalId);
      AcknowledgeSignal(signalId,"accepted");
   }
   else
   {
      AcknowledgeSignal(signalId,"rejected");
   }
}

//+------------------------------------------------------------------+
void CheckBridgeHealth()
{
   if(TimeCurrent()-LastHealthCheck < 60) return;
   LastHealthCheck = TimeCurrent();
   string response;
   int http = HttpGet(InpBridgeUrl + "/mt5/health",response);
   if(http == 200) Print("MT5 signal bridge health: ",response);
   else if(http != -1) Print("MT5 bridge health check HTTP ",http,": ",response);
}

//+------------------------------------------------------------------+
int OnInit()
{
   if(InpEntriesPerSignal != 3 || InpRiskPerBasket <= 0.0 ||
      InpTargetProfit <= 0.0 || InpDailyLossLimitPct <= 0.0 ||
      InpMaxEntryDeviationR <= 0.0 || InpPollSeconds < 1 ||
      InpMagicNumber == 0 || InpApiKey == "" || InpClientId == "")
   {
      Print("Invalid settings. Required: 3 entries, positive risk/target, API key and client ID.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) != ACCOUNT_TRADE_MODE_DEMO)
   {
      Print("SAFETY STOP: This EA runs on DEMO accounts only. No orders will be sent.");
      return INIT_FAILED;
   }
   if(AccountInfoString(ACCOUNT_CURRENCY) != "USD")
   {
      Print("SAFETY STOP: Account currency must be USD because risk and target are $15/$30.");
      return INIT_FAILED;
   }
   if((ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE) != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
   {
      Print("SAFETY STOP: A hedging account is required for three separate entries.");
      return INIT_FAILED;
   }
   if(StringFind(InpBridgeUrl,"https://") != 0)
   {
      Print("Bridge URL must use HTTPS.");
      return INIT_PARAMETERS_INCORRECT;
   }

   RefreshDailyBaseline();
   EventSetTimer(InpPollSeconds);
   Print("Deriv Signal Assistant V2.11 initialized in DEMO mode. Trading enabled=",
         (InpEnableTrading ? "true" : "false"),
         " observation only=",(InpObserveOnly ? "true" : "false"),
         ". Markets: R_10, R_25, R_50, R_75, JD100, CRASH500, BOOM500. Gold excluded.");
   CheckBridgeHealth();
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
}

//+------------------------------------------------------------------+
void OnTimer()
{
   SyncOpenTradeBaskets();
   SyncClosedTradeDeals();
   ManageBasket();
   if(CountOurPositions() > 0) return;
   CheckBridgeHealth();
   if(InpObserveOnly)
   {
      PollSignalQueue();
      return;
   }
   if(!InpEnableTrading) return;
   if(DailyLossLimitReached())
   {
      Print("Daily equity loss limit reached. New baskets disabled until next server day.");
      return;
   }
   PollSignalQueue();
}

//+------------------------------------------------------------------+
void OnTick()
{
   // Basket monitoring and multi-market signal polling run from OnTimer.
}
//+------------------------------------------------------------------+
